import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  moment,
  normalizePath,
} from "obsidian";
import { addCollisionSuffix, DeleteAction, isPathInFolder, resolveDeleteAction } from "./path";

interface ArchiveSettings {
  archiveFolder: string;
  preserveFolders: boolean;
  deleteAction: DeleteAction;
  showArchiveMenu: boolean;
  addTag: boolean;
  tag: string;
  addArchivedDate: boolean;
  archivedProperty: string;
  addCreatedDate: boolean;
  createdProperty: string;
  addModifiedDate: boolean;
  modifiedProperty: string;
  dateFormat: string;
}

const DEFAULT_SETTINGS: ArchiveSettings = {
  archiveFolder: "Archive",
  preserveFolders: false,
  deleteAction: "ask",
  showArchiveMenu: true,
  addTag: true,
  tag: "archived",
  addArchivedDate: true,
  archivedProperty: "archived",
  addCreatedDate: true,
  createdProperty: "created",
  addModifiedDate: true,
  modifiedProperty: "modified",
  dateFormat: "YYYY-MM-DD",
};

type DeleteChoice = "archive" | "delete" | "cancel";

class ArchiveDeleteModal extends Modal {
  private resolve?: (choice: DeleteChoice) => void;

  choose(file: TFile): Promise<DeleteChoice> {
    this.setTitle("Archive or delete?");
    this.contentEl.createEl("p", { text: `What would you like to do with “${file.name}”?` });
    this.contentEl.createEl("p", { text: "Delete follows your Obsidian trash setting and may be permanent." });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.finish("cancel")))
      .addButton((button) => button.setButtonText("Delete").setWarning().onClick(() => this.finish("delete")))
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
  settings: ArchiveSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    const loaded = (await this.loadData() ?? {}) as Partial<ArchiveSettings> & { promptOnDelete?: boolean };
    const { promptOnDelete, ...saved } = loaded;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved, {
      deleteAction: resolveDeleteAction(saved.deleteAction, promptOnDelete),
    });
    this.addSettingTab(new ArchiveSettingTab(this.app, this));

    this.addCommand({
      id: "archive-current-file",
      name: "Archive current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || this.isArchived(file)) return false;
        if (!checking) void this.archive(file);
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (this.settings.showArchiveMenu && file instanceof TFile && !this.isArchived(file)) {
        menu.addItem((item) => item
          .setTitle("Archive")
          .setIcon("archive")
          .setSection("danger")
          .onClick(() => void this.archive(file)));
      }
    }));

    const manager = this.app.fileManager;
    const originalPrompt = manager.promptForDeletion.bind(manager);
    const prompt = async (file: TAbstractFile): Promise<boolean> => {
      if (!(file instanceof TFile) || this.isArchived(file) || this.settings.deleteAction === "delete") {
        return originalPrompt(file);
      }
      if (this.settings.deleteAction === "archive") return this.archive(file);
      const choice = await new ArchiveDeleteModal(this.app).choose(file);
      if (choice === "archive") return this.archive(file);
      // trashFile respects Obsidian's configured system, vault, or permanent deletion setting.
      if (choice === "delete") await manager.trashFile(file);
      return choice === "delete";
    };
    manager.promptForDeletion = prompt;
    this.register(() => {
      if (manager.promptForDeletion === prompt) manager.promptForDeletion = originalPrompt;
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async archive(file: TFile): Promise<boolean> {
    try {
      const archiveFolder = normalizePath(this.settings.archiveFolder.trim());
      if (!archiveFolder || archiveFolder === ".") throw new Error("Choose an archive folder in settings.");
      if (isPathInFolder(file.path, archiveFolder)) {
        new Notice(`${file.name} is already archived.`);
        return false;
      }

      const created = file.stat.ctime;
      const modified = file.stat.mtime;
      const relativePath = this.settings.preserveFolders ? file.path : file.name;
      const wantedPath = normalizePath(`${archiveFolder}/${relativePath}`);
      await this.ensureFolder(wantedPath.slice(0, wantedPath.lastIndexOf("/")));
      const destination = this.uniquePath(wantedPath);
      await this.app.fileManager.renameFile(file, destination);
      try {
        await this.addMetadata(file, created, modified);
      } catch (error) {
        console.error("Integrated Archive metadata:", error);
        new Notice(`Archived to ${destination}, but its metadata could not be updated.`);
        return true;
      }
      new Notice(`Archived to ${destination}`);
      return true;
    } catch (error) {
      console.error("Integrated Archive:", error);
      new Notice(`Could not archive ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private isArchived(file: TFile): boolean {
    const folder = normalizePath(this.settings.archiveFolder.trim());
    return !!folder && folder !== "." && isPathInFolder(file.path, folder);
  }

  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) throw new Error(`${current} is a file, not a folder.`);
      if (!existing) await this.app.vault.createFolder(current);
    }
  }

  private uniquePath(path: string): string {
    let number = 0;
    while (this.app.vault.getAbstractFileByPath(addCollisionSuffix(path, number))) number++;
    return addCollisionSuffix(path, number);
  }

  private async addMetadata(file: TFile, created: number, modified: number): Promise<void> {
    if (file.extension !== "md") return;
    const s = this.settings;
    if (!s.addTag && !s.addArchivedDate && !s.addCreatedDate && !s.addModifiedDate) return;

    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      if (s.addTag && s.tag.trim()) {
        const tag = s.tag.trim().replace(/^#/, "");
        const tags = Array.isArray(frontmatter.tags)
          ? frontmatter.tags.map((value: unknown) => String(value))
          : typeof frontmatter.tags === "string"
            ? frontmatter.tags.split(/[ ,]+/).filter(Boolean)
            : [];
        frontmatter.tags = [...new Set([...tags, tag])];
      }
      const format = (timestamp: number) => moment(timestamp).format(s.dateFormat || DEFAULT_SETTINGS.dateFormat);
      if (s.addArchivedDate && s.archivedProperty.trim()) frontmatter[s.archivedProperty.trim()] = format(Date.now());
      if (s.addCreatedDate && s.createdProperty.trim()) frontmatter[s.createdProperty.trim()] = format(created);
      if (s.addModifiedDate && s.modifiedProperty.trim()) frontmatter[s.modifiedProperty.trim()] = format(modified);
    });
  }
}

class ArchiveSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: IntegratedArchivePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName("Archiving").setHeading();
    new Setting(containerEl).setName("Archive folder").setDesc("Path relative to the vault root.")
      .addText((text) => text.setPlaceholder("Archive").setValue(s.archiveFolder).onChange(async (value) => {
        s.archiveFolder = value;
        await this.plugin.saveSettings();
      }));
    this.toggle(containerEl, "Preserve folder structure", "Keep each file’s original folders inside the archive.", "preserveFolders");
    new Setting(containerEl)
      .setName("When deleting")
      .setDesc("Choose what happens to files outside the archive. Archived files always use Obsidian’s normal delete flow.")
      .addDropdown((dropdown) => dropdown
        .addOption("ask", "Ask every time")
        .addOption("archive", "Archive automatically")
        .addOption("delete", "Delete normally")
        .setValue(s.deleteAction)
        .onChange(async (value) => {
          s.deleteAction = value as DeleteAction;
          await this.plugin.saveSettings();
        }));
    this.toggle(containerEl, "Show archive in file menus", "Add Archive directly below Delete in file context menus.", "showArchiveMenu");

    new Setting(containerEl).setName("Metadata").setHeading();
    this.toggle(containerEl, "Add archive tag", "Add a tag to archived Markdown notes.", "addTag", true);
    if (s.addTag) this.text(containerEl, "Archive tag", "Tag without the # prefix.", "tag");

    this.toggle(containerEl, "Add archived date", "Record the day the note was archived.", "addArchivedDate", true);
    if (s.addArchivedDate) this.text(containerEl, "Archived date property", "Frontmatter property name.", "archivedProperty");
    this.toggle(containerEl, "Add created date", "Record the file system creation day.", "addCreatedDate", true);
    if (s.addCreatedDate) this.text(containerEl, "Created date property", "Frontmatter property name.", "createdProperty");
    this.toggle(containerEl, "Add last edited date", "Record the modification day from before archiving.", "addModifiedDate", true);
    if (s.addModifiedDate) this.text(containerEl, "Last edited property", "Frontmatter property name.", "modifiedProperty");
    if (s.addArchivedDate || s.addCreatedDate || s.addModifiedDate) {
      this.text(containerEl, "Date format", "Moment format, for example YYYY-MM-DD or DD/MM/YYYY.", "dateFormat");
    }
  }

  private toggle(container: HTMLElement, name: string, description: string, key: keyof Pick<ArchiveSettings,
    "preserveFolders" | "showArchiveMenu" | "addTag" | "addArchivedDate" | "addCreatedDate" | "addModifiedDate">,
  redisplay = false): void {
    new Setting(container).setName(name).setDesc(description).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value;
        await this.plugin.saveSettings();
        if (redisplay) this.display();
      }));
  }

  private text(container: HTMLElement, name: string, description: string, key: keyof Pick<ArchiveSettings,
    "tag" | "archivedProperty" | "createdProperty" | "modifiedProperty" | "dateFormat">): void {
    new Setting(container).setName(name).setDesc(description).addText((text) =>
      text.setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value;
        await this.plugin.saveSettings();
      }));
  }
}
