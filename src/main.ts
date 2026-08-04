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
  moment,
  normalizePath,
} from "obsidian";
import { ArchiveManager, type ArchiveHost } from "./archive";
import { installDeletionInterceptor, type DeleteChoice } from "./delete";
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  type ArchiveSettings,
  validateArchiveFolder,
  validateDateProperty,
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
  settings: ArchiveSettings = DEFAULT_SETTINGS;
  private archiveManager!: ArchiveManager<TFile>;
  private settingTab!: ArchiveSettingTab;

  async onload(): Promise<void> {
    await this.loadSettings();
    const host: ArchiveHost<TFile> = {
      createFolder: (path) => this.app.vault.createFolder(path).then(() => undefined),
      formatDate: (timestamp, pattern) => createMoment(timestamp).format(pattern),
      getEntryKind: (path) => {
        const entry = this.app.vault.getAbstractFileByPath(path);
        return entry instanceof TFile ? "file" : entry ? "folder" : null;
      },
      normalizePath,
      now: Date.now,
      processFrontMatter: (file, update) => this.app.fileManager.processFrontMatter(file, update),
      renameFile: (file, destination) => this.app.fileManager.renameFile(file, destination),
    };
    this.archiveManager = new ArchiveManager(host, () => this.settings);
    this.settingTab = new ArchiveSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

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
      if (result.metadataError) {
        console.error("Integrated Archive metadata:", result.metadataError);
        new Notice(`Archived to ${result.destination}, but its metadata could not be updated.`);
        return true;
      }
      new Notice(`Archived to ${result.destination}`);
      return true;
    } catch (error) {
      console.error("Integrated Archive:", error);
      new Notice(`Could not archive ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private isArchived(file: TFile): boolean {
    return this.archiveManager.isArchived(file);
  }

  private async loadSettings(): Promise<void> {
    this.settings = sanitizeSettings(await this.loadData());
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
            control: { type: "text", key: "archivedProperty", validate: (value) => validateDateProperty(s, "archivedProperty", value) },
          },
          { name: "Add created date", desc: "Record the file system creation day.", control: { type: "toggle", key: "addCreatedDate" } },
          {
            name: "Created date property",
            desc: "Frontmatter property name.",
            visible: () => s.addCreatedDate,
            control: { type: "text", key: "createdProperty", validate: (value) => validateDateProperty(s, "createdProperty", value) },
          },
          { name: "Add last edited date", desc: "Record the modification day from before archiving.", control: { type: "toggle", key: "addModifiedDate" } },
          {
            name: "Last edited property",
            desc: "Frontmatter property name.",
            visible: () => s.addModifiedDate,
            control: { type: "text", key: "modifiedProperty", validate: (value) => validateDateProperty(s, "modifiedProperty", value) },
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
            control: { type: "text", key: "dateFormat" },
          },
        ],
      },
    ];
  }
}
