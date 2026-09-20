import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  TAbstractFile,
  TFile,
  TFolder,
  moment,
  normalizePath,
} from "obsidian";
import { ArchiveManager, type ArchiveHost } from "./archive";
import { runBatch } from "./batch";
import { installDeletionInterceptor, type DeleteChoice } from "./delete";
import {
  DEFAULT_DATA,
  sanitizeData,
  type ArchiveData,
  type ArchiveSettings,
  validateArchiveFolder,
  validateDateFormat,
  validateExcludedPaths,
  validatePropertySlot,
  validateTag,
} from "./settings";

const createMoment = moment as unknown as (timestamp: number) => { format(pattern: string): string };

class ArchiveDeleteModal extends Modal {
  private resolve?: (choice: DeleteChoice) => void;

  choose(file: TFile): Promise<DeleteChoice> {
    this.setTitle("Archive or delete?");
    this.contentEl.createEl("p", { text: `What would you like to do with “${file.name}”?` });
    this.contentEl.createEl("p", { text: "Delete follows your Obsidian trash setting and may be permanent." });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.finish("cancel")))
      .addButton((button) => button.setButtonText("Delete").setDestructive().onClick(() => this.finish("delete")))
      .addButton((button) => button.setButtonText("Archive").setCta().onClick(() => this.finish("archive")));
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(choice: DeleteChoice): void {
    this.resolve?.(choice);
    this.resolve = undefined;
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve?.("cancel");
    this.resolve = undefined;
  }
}

export default class IntegratedArchivePlugin extends Plugin {
  settings: ArchiveData = DEFAULT_DATA;
  private archiveManager!: ArchiveManager<TFile>;
  private settingTab!: ArchiveSettingTab;

  async onload(): Promise<void> {
    await this.loadSettings();
    const host: ArchiveHost<TFile> = {
      createFolder: (path) => this.app.vault.createFolder(path).then(() => undefined),
      formatDate: (timestamp, pattern) => createMoment(timestamp).format(pattern),
      getArchiveHistory: () => this.settings.archiveHistory,
      getEntryKind: (path) => {
        const entry = this.app.vault.getAbstractFileByPath(path);
        if (entry instanceof TFile) return "file";
        return entry ? "folder" : null;
      },
      getFile: (path) => {
        const entry = this.app.vault.getAbstractFileByPath(path);
        return entry instanceof TFile ? entry : null;
      },
      getFrontmatter: (file) => Promise.resolve(this.app.metadataCache.getFileCache(file)?.frontmatter),
      normalizePath,
      now: Date.now,
      processFrontMatter: (file, update) => this.app.fileManager.processFrontMatter(file, update),
      renameFile: (file, destination) => this.app.fileManager.renameFile(file, destination),
      saveArchiveHistory: async (records) => {
        this.settings.archiveHistory = records;
        await this.saveData(this.settings);
      },
    };
    this.archiveManager = new ArchiveManager(host, () => this.settings);
    this.settingTab = new ArchiveSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.addCommand({
      id: "archive-current-file",
      name: "Archive current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || this.isArchived(file) || this.archiveManager.isExcludedPath(file.path)) return false;
        if (!checking) void this.archive(file);
        return true;
      },
    });

    this.addCommand({
      id: "restore-current-file",
      name: "Restore current file from archive",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.isArchived(file)) return false;
        if (!checking) void this.restore(file);
        return true;
      },
    });

    this.addCommand({
      id: "undo-last-archive",
      name: "Undo last archive",
      checkCallback: (checking) => {
        if (!this.archiveManager.canUndo()) return false;
        if (!checking) void this.undoLastArchive();
        return true;
      },
    });

    this.addCommand({
      id: "archive-current-folder",
      name: "Archive all files in current folder",
      checkCallback: (checking) => {
        const folder = this.activeFolder();
        if (!folder) return false;
        const files = this.collectArchivableFiles(folder);
        if (!files.length) return false;
        if (!checking) void this.archiveMany(files);
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!this.settings.showArchiveMenu) return;
      if (file instanceof TFolder) {
        if (this.archiveManager.isArchivedPath(file.path)) return;
        const files = this.collectArchivableFiles(file);
        if (!files.length) return;
        menu.addItem((item) => item
          .setTitle(`Archive ${files.length} ${files.length === 1 ? "file" : "files"}`)
          .setIcon("archive")
          .setSection("danger")
          .onClick(() => void this.archiveMany(files)));
        return;
      }
      if (!(file instanceof TFile)) return;
      if (this.isArchived(file)) {
        menu.addItem((item) => item
          .setTitle("Restore from archive")
          .setIcon("undo-2")
          .setSection("action")
          .onClick(() => void this.restore(file)));
      } else if (!this.archiveManager.isExcludedPath(file.path)) {
        menu.addItem((item) => item
          .setTitle("Archive")
          .setIcon("archive")
          .setSection("danger")
          .onClick(() => void this.archive(file)));
      }
    }));

    this.registerEvent(this.app.workspace.on("files-menu", (menu, files) => {
      if (!this.settings.showArchiveMenu) return;
      const activeFiles = files.filter((file): file is TFile => file instanceof TFile && !this.isArchived(file));
      const archivedFiles = files.filter((file): file is TFile => file instanceof TFile && this.isArchived(file));
      if (activeFiles.length) {
        menu.addItem((item) => item
          .setTitle(`Archive ${activeFiles.length} ${activeFiles.length === 1 ? "file" : "files"}`)
          .setIcon("archive")
          .setSection("danger")
          .onClick(() => void this.archiveMany(activeFiles)));
      }
      if (archivedFiles.length) {
        menu.addItem((item) => item
          .setTitle(`Restore ${archivedFiles.length} ${archivedFiles.length === 1 ? "file" : "files"}`)
          .setIcon("undo-2")
          .setSection("action")
          .onClick(() => void this.restoreMany(archivedFiles)));
      }
    }));

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.archiveManager.reconcileRename(oldPath, file.path);
    }));

    this.register(installDeletionInterceptor<TAbstractFile, TFile>(this.app.fileManager, {
      archive: (file) => this.archive(file),
      choose: (file) => new ArchiveDeleteModal(this.app).choose(file),
      getAction: () => this.settings.deleteAction,
      isArchived: (file) => this.isArchived(file),
      isFile: (file): file is TFile => file instanceof TFile,
    }));
  }

  async onExternalSettingsChange(): Promise<void> {
    await this.loadSettings();
    this.settingTab.update();
  }

  async archive(file: TFile): Promise<boolean> {
    try {
      const result = await this.archiveManager.archive(file);
      this.reportArchiveResult(result);
      return true;
    } catch (error) {
      console.error("Integrated Archive:", error);
      new Notice(`Could not archive ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async restore(file: TFile): Promise<boolean> {
    try {
      const result = await this.archiveManager.restore(file);
      this.reportRestoreResult(result);
      return true;
    } catch (error) {
      console.error("Integrated Archive restore:", error);
      new Notice(`Could not restore ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async archiveMany(files: TFile[]): Promise<void> {
    const result = await runBatch(files, (file) => this.archiveManager.archive(file));
    for (const failure of result.failed) console.error(`Integrated Archive ${failure.item.path}:`, failure.error);
    const warnings = result.succeeded.filter(({ result: item }) => item.metadataError || item.historyError).length;
    new Notice(this.batchNotice("Archived", result.succeeded.length, result.failed.length, warnings));
  }

  private async restoreMany(files: TFile[]): Promise<void> {
    const result = await runBatch(files, (file) => this.archiveManager.restore(file));
    for (const failure of result.failed) console.error(`Integrated Archive restore ${failure.item.path}:`, failure.error);
    const warnings = result.succeeded.filter(({ result: item }) =>
      item.historyError || item.metadataError || item.inferredOriginalPath).length;
    new Notice(this.batchNotice("Restored", result.succeeded.length, result.failed.length, warnings));
  }

  private async undoLastArchive(): Promise<void> {
    try {
      const result = await this.archiveManager.undoLastArchive();
      this.reportRestoreResult(result);
    } catch (error) {
      console.error("Integrated Archive undo:", error);
      new Notice(`Could not undo archive: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isArchived(file: TFile): boolean {
    return this.archiveManager.isArchived(file);
  }

  private activeFolder(): TFolder | null {
    const file = this.app.workspace.getActiveFile();
    const folder = file?.parent ?? null;
    if (!folder || this.archiveManager.isArchivedPath(folder.path)) return null;
    return folder;
  }

  private collectArchivableFiles(folder: TFolder): TFile[] {
    const files: TFile[] = [];
    const walk = (current: TFolder): void => {
      for (const child of current.children) {
        if (child instanceof TFile) {
          if (!this.isArchived(child) && !this.archiveManager.isExcludedPath(child.path)) files.push(child);
        } else if (child instanceof TFolder) {
          walk(child);
        }
      }
    };
    walk(folder);
    return files;
  }

  private async loadSettings(): Promise<void> {
    this.settings = sanitizeData(await this.loadData());
  }

  private reportArchiveResult(result: Awaited<ReturnType<ArchiveManager<TFile>["archive"]>>): void {
    if (result.metadataError) console.error("Integrated Archive metadata:", result.metadataError);
    if (result.historyError) console.error("Integrated Archive history:", result.historyError);
    if (result.metadataError || result.historyError) {
      const failed = [result.metadataError && "metadata", result.historyError && "archive history"].filter(Boolean).join(" and ");
      new Notice(`Archived to ${result.destination}, but ${failed} could not be updated.`);
    } else {
      new Notice(`Archived to ${result.destination}`);
    }
  }

  private batchNotice(verb: string, succeeded: number, failed: number, warnings: number): string {
    const details = [failed && `${failed} failed`, warnings && `${warnings} completed with warnings`].filter(Boolean);
    const noun = succeeded === 1 ? "file" : "files";
    const suffix = details.length ? `; ${details.join("; ")}` : "";
    return `${verb} ${succeeded} ${noun}${suffix}.`;
  }

  private reportRestoreResult(result: Awaited<ReturnType<ArchiveManager<TFile>["restore"]>>): void {
    if (result.metadataError) console.error("Integrated Archive metadata restore:", result.metadataError);
    if (result.historyError) console.error("Integrated Archive history:", result.historyError);
    const failed = [result.metadataError && "metadata", result.historyError && "archive history"].filter(Boolean).join(" and ");
    if (failed) {
      new Notice(`Restored to ${result.destination}, but ${failed} could not be updated.`);
    } else if (result.inferredOriginalPath) {
      new Notice(`Restored to ${result.destination}. The original location was inferred because no history was available.`);
    } else {
      new Notice(`Restored to ${result.destination}`);
    }
  }
}

class ArchiveSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: IntegratedArchivePlugin) {
    super(app, plugin);
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    await super.setControlValue(key, value);
    this.refreshDomState();
  }

  getSettingDefinitions(): SettingDefinitionItem<keyof ArchiveSettings>[] {
    const s = this.plugin.settings;
    return [
      {
        type: "group",
        heading: "Archiving",
        items: [
          {
            name: "Archive folder",
            desc: "Path relative to the vault root.",
            control: { type: "text", key: "archiveFolder", placeholder: "Archive", validate: validateArchiveFolder },
          },
          { name: "Preserve folder structure", desc: "Keep each file’s original folders inside the archive.", control: { type: "toggle", key: "preserveFolders" } },
          {
            name: "When deleting",
            desc: "Choose what happens to files outside the archive. Archived files always use Obsidian’s normal delete flow.",
            control: { type: "dropdown", key: "deleteAction", options: { ask: "Ask every time", archive: "Archive automatically", delete: "Delete normally" } },
          },
          { name: "Show archive in file menus", desc: "Add Archive directly below Delete in file context menus.", control: { type: "toggle", key: "showArchiveMenu" } },
          {
            name: "Protected paths",
            desc: "One vault-relative path per line. Files and folders here are never archived.",
            control: { type: "textarea", key: "excludedPaths", placeholder: "Private\nTemplates", rows: 4, validate: validateExcludedPaths },
          },
        ],
      },
      {
        type: "group",
        heading: "Metadata",
        items: [
          { name: "Add archive tag", desc: "Add a tag to archived Markdown notes.", control: { type: "toggle", key: "addTag" } },
          {
            name: "Archive tag",
            desc: "Tag without the # prefix.",
            visible: () => s.addTag,
            control: { type: "text", key: "tag", validate: validateTag },
          },
          { name: "Add archived date", desc: "Record the day the note was archived.", control: { type: "toggle", key: "addArchivedDate" } },
          {
            name: "Archived date property",
            desc: "Frontmatter property name.",
            visible: () => s.addArchivedDate,
            control: { type: "text", key: "archivedProperty", validate: (value) => validatePropertySlot(s, "archivedProperty", value) },
          },
          { name: "Add created date", desc: "Record the file system creation day.", control: { type: "toggle", key: "addCreatedDate" } },
          {
            name: "Created date property",
            desc: "Frontmatter property name.",
            visible: () => s.addCreatedDate,
            control: { type: "text", key: "createdProperty", validate: (value) => validatePropertySlot(s, "createdProperty", value) },
          },
          { name: "Add last edited date", desc: "Record the modification day from before archiving.", control: { type: "toggle", key: "addModifiedDate" } },
          {
            name: "Last edited property",
            desc: "Frontmatter property name.",
            visible: () => s.addModifiedDate,
            control: { type: "text", key: "modifiedProperty", validate: (value) => validatePropertySlot(s, "modifiedProperty", value) },
          },
          {
            name: "Existing created and edited dates",
            desc: "Choose whether archiving replaces values already stored in those properties.",
            visible: () => s.addCreatedDate || s.addModifiedDate,
            control: { type: "dropdown", key: "existingDateAction", options: { preserve: "Keep existing", overwrite: "Replace existing" } },
          },
          {
            name: "Date format",
            desc: "Moment format, for example YYYY-MM-DD or DD/MM/YYYY.",
            visible: () => s.addArchivedDate || s.addCreatedDate || s.addModifiedDate,
            control: { type: "text", key: "dateFormat", validate: validateDateFormat },
          },
        ],
      },
      {
        type: "group",
        heading: "Restore",
        items: [
          {
            name: "Store original path in notes",
            desc: "Write the original location into archived Markdown notes so they can return home even if archive history is lost or synced to another device.",
            control: { type: "toggle", key: "storeOriginalPath" },
          },
          {
            name: "Original path property",
            desc: "Frontmatter property name.",
            visible: () => s.storeOriginalPath,
            control: { type: "text", key: "originalPathProperty", validate: (value) => validatePropertySlot(s, "originalPathProperty", value) },
          },
        ],
      },
    ];
  }
}
