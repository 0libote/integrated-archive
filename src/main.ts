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
  getLinkpath,
  moment,
  normalizePath,
} from "obsidian";
import { ArchiveManager, type ArchiveGroupResult, type ArchiveHost, type AttachmentPlan, type RestoreGroupResult } from "./archive";
import { runBatch } from "./batch";
import { installDeletionInterceptor, type DeleteChoice } from "./delete";
import {
  DEFAULT_DATA,
  sanitizeData,
  type ArchiveData,
  type ArchiveSettings,
  validateArchiveFolder,
  validateDateFormat,
  validateDateProperty,
  validateExcludedOverlap,
  validateExcludedPaths,
  validatePropertySlot,
  validateTag,
} from "./settings";

const createMoment = moment as unknown as (timestamp: number) => { format(pattern: string): string };

abstract class ChoiceModal<T> extends Modal {
  private resolve?: (choice: T) => void;
  private readonly fallback: T;

  constructor(app: App, fallback: T) {
    super(app);
    this.fallback = fallback;
  }

  choose(): Promise<T> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  protected finish(choice: T): void {
    this.resolve?.(choice);
    this.resolve = undefined;
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve?.(this.fallback);
    this.resolve = undefined;
  }
}

class ArchiveDeleteModal extends ChoiceModal<DeleteChoice> {
  constructor(app: App, private readonly file: TFile) {
    super(app, "cancel");
  }

  override onOpen(): void {
    // Build UI here (rather than in choose()) so nothing touches the DOM
    // until Obsidian actually opens the modal. Building content earlier
    // risks attaching DOM while the loading splash is still visible.
    this.setTitle("Archive or delete?");
    this.contentEl.createEl("p", { text: `What would you like to do with “${this.file.name}”?` });
    this.contentEl.createEl("p", { text: "Delete follows your Obsidian trash setting and may be permanent." });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.finish("cancel")))
      .addButton((button) => button.setButtonText("Delete").setDestructive().onClick(() => this.finish("delete")))
      .addButton((button) => button.setButtonText("Archive").setCta().onClick(() => this.finish("archive")));
  }
}

export const BULK_CONFIRM_THRESHOLD = 10;

export function needsBulkConfirm(count: number, threshold = BULK_CONFIRM_THRESHOLD): boolean {
  return count > threshold;
}

export function isExternalFile(file: TFile): boolean {
  // TExternalFile (Obsidian 1.14.4+) extends TFile and adds getRealPath().
  // Duck-type the capability instead of importing the class so this keeps
  // working on older app versions where the export does not exist.
  return typeof (file as { getRealPath?: unknown }).getRealPath === "function";
}

class ConfirmBulkModal extends ChoiceModal<boolean> {
  constructor(app: App, private readonly title: string, private readonly message: string) {
    super(app, false);
  }

  override onOpen(): void {
    // See ArchiveDeleteModal: build UI on open so no DOM is touched before
    // the modal is actually shown (e.g. over the startup splash).
    this.setTitle(this.title);
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.finish(false)))
      .addButton((button) => button.setButtonText("Continue").setCta().onClick(() => this.finish(true)));
  }
}

export default class IntegratedArchivePlugin extends Plugin {
  settings: ArchiveData = DEFAULT_DATA;
  private archiveManager!: ArchiveManager<TFile>;
  private settingTab!: ArchiveSettingTab;
  private layoutReadyPromise: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    await this.loadSettings();
    // Resolve once the workspace layout is ready. Deletion prompts, archive
    // modals, and their Notices must wait for this: opening them while the
    // startup splash is still visible flashes a box over the loading screen,
    // and mutating the vault before layout is ready risks racing startup.
    this.layoutReadyPromise = new Promise<void>((resolve) => {
      const workspace = this.app.workspace as unknown as {
        layoutReady?: boolean;
        onLayoutReady?: (callback: () => unknown) => void;
      };
      if (!workspace || workspace.layoutReady || typeof workspace.onLayoutReady !== "function") {
        resolve();
      } else {
        workspace.onLayoutReady(() => resolve());
      }
    });
    const host: ArchiveHost<TFile> = {
      createFolder: (path) => this.app.vault.createFolder(path).then(() => undefined),
      deleteFolder: async (path) => {
        const entry = this.app.vault.getAbstractFileByPath(path);
        // Route through the file manager so empty-folder cleanup respects the
        // user's trash preference. Only already-empty folders reach this point.
        if (entry instanceof TFolder) await this.app.fileManager.trashFile(entry);
      },
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
      getFolderChildren: (path) => {
        const entry = this.app.vault.getAbstractFileByPath(path);
        if (!(entry instanceof TFolder)) return null;
        return entry.children.map((child) => child.path);
      },
      getFrontmatter: (file) => Promise.resolve(this.app.metadataCache.getFileCache(file)?.frontmatter),
      listIncomingLinks: (destPath) => this.collectIncomingLinks(destPath),
      listOutgoingLinks: (sourcePath) => this.collectOutgoingLinks(sourcePath),
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
        if (!file || !this.isVaultFile(file) || this.isArchived(file) || this.archiveManager.isExcludedPath(file.path)) return false;
        if (!checking) void this.archive(file);
        return true;
      },
    });

    this.addCommand({
      id: "restore-current-file",
      name: "Restore current file from archive",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.isVaultFile(file) || !this.isArchived(file)) return false;
        if (!checking) void this.restore(file);
        return true;
      },
    });

    this.addCommand({
      id: "undo-last-archive",
      name: "Undo last file archive",
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
        // Enablement checks run on every palette hover: stop at the first
        // eligible file instead of walking the whole subtree.
        if (checking) return this.hasArchivableFiles(folder);
        const files = this.collectArchivableFiles(folder);
        if (!files.length) return false;
        void this.archiveMany(files);
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
      if (!this.isVaultFile(file)) return;
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
      const activeFiles = files.filter((file): file is TFile => this.isVaultFile(file) && !this.isArchived(file) && !this.archiveManager.isExcludedPath(file.path));
      const archivedFiles = files.filter((file): file is TFile => this.isVaultFile(file) && this.isArchived(file));
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
      void this.archiveManager.reconcileRename(oldPath, file.path)
        .catch((error) => console.error("Integrated Archive rename:", error));
    }));

    this.register(installDeletionInterceptor<TAbstractFile, TFile>(this.app.fileManager, {
      archive: (file) => this.archiveWhenReady(file),
      choose: (file) => this.chooseWhenReady(file),
      getAction: () => this.settings.deleteAction,
      isArchived: (file) => this.isArchived(file),
      isFile: (file): file is TFile => this.isVaultFile(file),
    }));
  }

  private waitForLayoutReady(): Promise<void> {
    return this.layoutReadyPromise;
  }

  private async archiveWhenReady(file: TFile): Promise<boolean> {
    await this.waitForLayoutReady();
    return this.archive(file);
  }

  private async chooseWhenReady(file: TFile): Promise<DeleteChoice> {
    await this.waitForLayoutReady();
    return new ArchiveDeleteModal(this.app, file).choose();
  }

  async onExternalSettingsChange(): Promise<void> {
    await this.loadSettings();
    this.settingTab.update();
  }

  async archive(file: TFile): Promise<boolean> {
    if (isExternalFile(file)) {
      new Notice(`Cannot archive ${file.name}: files outside the vault are not supported.`);
      return false;
    }
    try {
      if (this.settings.archiveAttachments && file.extension === "md") {
        const plan = await this.archiveManager.collectAttachments(file);
        if (needsBulkConfirm(1 + plan.attachments.length)) {
          await this.waitForLayoutReady();
          const noun = plan.attachments.length === 0 ? "file" : "files";
          const confirmed = await new ConfirmBulkModal(
            this.app,
            `Archive ${1 + plan.attachments.length} ${noun}?`,
            `This will archive ${1 + plan.attachments.length} ${noun} together. Continue?`,
          ).choose();
          if (!confirmed) return false;
        }
      }
      const result = await this.archiveManager.archiveWithAttachments(file);
      this.reportArchiveGroupResult(result);
      return true;
    } catch (error) {
      console.error("Integrated Archive:", error);
      new Notice(`Could not archive ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async restore(file: TFile): Promise<boolean> {
    if (isExternalFile(file)) {
      new Notice(`Cannot restore ${file.name}: files outside the vault are not supported.`);
      return false;
    }
    try {
      const groupId = this.archiveManager.getRecordGroup(file.path);
      if (groupId) {
        const count = this.archiveManager.listGroupArchivedPaths(groupId).length;
        if (needsBulkConfirm(Math.max(count, 1))) {
          await this.waitForLayoutReady();
          const noun = count === 1 ? "file" : "files";
          const confirmed = await new ConfirmBulkModal(
            this.app,
            `Restore ${count} ${noun}?`,
            `This will restore ${count} ${noun} to their original locations. Continue?`,
          ).choose();
          if (!confirmed) return false;
        }
      }
      const result = await this.archiveManager.restoreWithGroup(file);
      this.reportRestoreGroupResult(result);
      return true;
    } catch (error) {
      console.error("Integrated Archive restore:", error);
      new Notice(`Could not restore ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async archiveMany(files: TFile[]): Promise<void> {
    const eligible = files.filter((file) => this.isVaultFile(file));
    if (!eligible.length) return;
    const expanded = await this.expandWithAttachments(eligible);
    if (needsBulkConfirm(expanded.items.length)) {
      await this.waitForLayoutReady();
      const noun = expanded.items.length === 1 ? "file" : "files";
      const confirmed = await new ConfirmBulkModal(
        this.app,
        `Archive ${expanded.items.length} ${noun}?`,
        `This will archive ${expanded.items.length} ${noun}. Continue?`,
      ).choose();
      if (!confirmed) return;
    }
    const result = await runBatch(expanded.items, (file) =>
      this.archiveManager.archive(file, { groupId: expanded.groups.get(file.path) }));
    for (const failure of result.failed) console.error(`Integrated Archive ${failure.item.path}:`, failure.error);
    const warnings = result.succeeded.filter(({ result: item }) => item.metadataError || item.historyError).length;
    let message = this.batchNotice("Archived", result.succeeded.length, result.failed.length, warnings);
    if (expanded.sharedSkipped > 0) {
      message += ` ${expanded.sharedSkipped} ${expanded.sharedSkipped === 1 ? "attachment" : "attachments"} left in place (shared or link index not ready).`;
    }
    new Notice(message);
  }

  /**
   * Expand a file list with exclusively-used attachments so batch archiving
   * moves each note together with its attachments. Attachments share their
   * note's group id so restoring the note brings them back. One shared cache
   * is reused so N notes do not rescan the vault N times per image.
   */
  private async expandWithAttachments(files: TFile[]): Promise<{ groups: Map<string, string>; items: TFile[]; sharedSkipped: number }> {
    const items = [...files];
    const groups = new Map<string, string>();
    const seen = new Set(files.map((file) => file.path));
    const sharedSkipped = new Set<string>();
    const incomingCache = new Map<string, string[]>();
    for (const file of files) {
      let plan: AttachmentPlan<TFile>;
      try {
        plan = await this.archiveManager.collectAttachments(file, incomingCache);
      } catch {
        continue;
      }
      for (const path of plan.sharedSkipped) sharedSkipped.add(path);
      if (!plan.attachments.length) continue;
      const groupId = this.archiveManager.makeGroupId(file.path);
      groups.set(file.path, groupId);
      for (const attachment of plan.attachments) {
        const existing = groups.get(attachment.path);
        if (existing && existing !== groupId) {
          // Claimed by two different notes in this batch: leave it ungrouped
          // so no single note implies ownership of a shared file.
          groups.delete(attachment.path);
          if (seen.has(attachment.path)) continue;
          seen.add(attachment.path);
          items.push(attachment);
          continue;
        }
        if (!existing) groups.set(attachment.path, groupId);
        if (seen.has(attachment.path)) continue;
        seen.add(attachment.path);
        groups.set(attachment.path, groupId);
        items.push(attachment);
      }
    }
    return { groups, items, sharedSkipped: sharedSkipped.size };
  }

  private async restoreMany(files: TFile[]): Promise<void> {
    const eligible = files.filter((file) => this.isVaultFile(file));
    if (!eligible.length) return;
    const items = this.expandWithGroupMembers(eligible);
    if (needsBulkConfirm(items.length)) {
      await this.waitForLayoutReady();
      const noun = items.length === 1 ? "file" : "files";
      const confirmed = await new ConfirmBulkModal(
        this.app,
        `Restore ${items.length} ${noun}?`,
        `This will restore ${items.length} ${noun} to their original locations. Continue?`,
      ).choose();
      if (!confirmed) return;
    }
    const result = await runBatch(items, (file) => this.archiveManager.restore(file));
    for (const failure of result.failed) console.error(`Integrated Archive restore ${failure.item.path}:`, failure.error);
    const warnings = result.succeeded.filter(({ result: item }) =>
      item.historyError || item.metadataError || item.inferredOriginalPath).length;
    new Notice(this.batchNotice("Restored", result.succeeded.length, result.failed.length, warnings));
  }

  /**
   * Expand selected archived files with fellow group members so a note
   * restore also brings back attachments archived with it.
   */
  private expandWithGroupMembers(files: TFile[]): TFile[] {
    const items = [...files];
    const seen = new Set(files.map((file) => file.path));
    for (const file of files) {
      const groupId = this.archiveManager.getRecordGroup(file.path);
      if (!groupId) continue;
      for (const archivedPath of this.archiveManager.listGroupArchivedPaths(groupId)) {
        if (seen.has(archivedPath)) continue;
        const entry = this.app.vault.getAbstractFileByPath(archivedPath);
        if (!entry || !this.isVaultFile(entry)) continue;
        seen.add(archivedPath);
        items.push(entry);
      }
    }
    return items;
  }

  private async undoLastArchive(): Promise<void> {
    try {
      const result = await this.archiveManager.undoLastArchiveGroup();
      this.reportRestoreGroupResult(result);
    } catch (error) {
      console.error("Integrated Archive undo:", error);
      new Notice(`Could not undo archive: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isArchived(file: TFile): boolean {
    return this.archiveManager.isArchived(file);
  }

  private isVaultFile(file: TAbstractFile): file is TFile {
    // External files (Obsidian 1.14.4+) live outside the vault, so none of
    // the vault-relative archive, restore, or trash handling applies to them.
    return file instanceof TFile && !isExternalFile(file);
  }

  private collectOutgoingLinks(sourcePath: string): string[] {
    const seen = new Set<string>();
    const resolved = this.app.metadataCache.resolvedLinks?.[sourcePath];
    if (resolved) {
      for (const destination of Object.keys(resolved)) seen.add(destination);
    }
    // resolvedLinks can lag behind edits, so also parse the cached links
    // directly as a fallback.
    const entry = this.app.vault.getAbstractFileByPath(sourcePath);
    if (entry instanceof TFile) {
      const cache = this.app.metadataCache.getFileCache(entry);
      const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
      for (const ref of refs) {
        const destination = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(ref.link), sourcePath);
        if (destination) seen.add(destination.path);
      }
    }
    seen.delete(sourcePath);
    return [...seen];
  }

  private collectIncomingLinks(destPath: string): string[] {
    const referrers: string[] = [];
    const seenReferrers = new Set<string>();
    const resolved = this.app.metadataCache.resolvedLinks ?? {};
    for (const [source, destinations] of Object.entries(resolved)) {
      if (destinations && Object.prototype.hasOwnProperty.call(destinations, destPath)) {
        referrers.push(source);
        seenReferrers.add(source);
      }
    }
    // The resolved index can lag behind per-file caches after edits.
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (seenReferrers.has(file.path)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) throw new Error("Link cache is not ready.");
      const refs = [...(cache.links ?? []), ...(cache.embeds ?? [])];
      if (refs.some((ref) => this.app.metadataCache.getFirstLinkpathDest(getLinkpath(ref.link), file.path)?.path === destPath)) {
        referrers.push(file.path);
        seenReferrers.add(file.path);
      }
    }
    return referrers;
  }

  private activeFolder(): TFolder | null {
    // Derived from the active file only: Obsidian exposes no "focused folder"
    // API for the command palette, so folder focus without an open file is
    // covered by the file menu instead.
    const file = this.app.workspace.getActiveFile();
    if (file && !this.isVaultFile(file)) return null;
    const folder = file?.parent ?? null;
    if (!folder || this.archiveManager.isArchivedPath(folder.path)) return null;
    // Guard the vault root: archiving "current folder" at the root would
    // archive the entire vault. The command stays hidden there instead.
    if (folder.path === "" || folder.path === "/" || folder.isRoot?.()) return null;
    return folder;
  }

  private hasArchivableFiles(folder: TFolder): boolean {
    const stack: TFolder[] = [folder];
    while (stack.length) {
      const current = stack.pop()!;
      for (const child of current.children) {
        if (child instanceof TFolder) {
          if (!this.archiveManager.isArchivedPath(child.path)) stack.push(child);
        } else if (this.isVaultFile(child) && !this.isArchived(child)
          && !this.archiveManager.isExcludedPath(child.path)) {
          return true;
        }
      }
    }
    return false;
  }

  private collectArchivableFiles(folder: TFolder): TFile[] {
    const files: TFile[] = [];
    const walk = (current: TFolder): void => {
      for (const child of current.children) {
        if (child instanceof TFolder) {
          // Mirror hasArchivableFiles: never descend into archived subtrees.
          if (!this.archiveManager.isArchivedPath(child.path)) walk(child);
        } else if (this.isVaultFile(child)) {
          if (!this.isArchived(child) && !this.archiveManager.isExcludedPath(child.path)) files.push(child);
        }
      }
    };
    walk(folder);
    return files;
  }

  private async loadSettings(): Promise<void> {
    this.settings = sanitizeData(await this.loadData());
  }

  private failedParts(metadataError: unknown, historyError: unknown): string {
    return [metadataError && "metadata", historyError && "archive history"].filter(Boolean).join(" and ");
  }

  private reportArchiveGroupResult(result: ArchiveGroupResult): void {
    for (const failure of result.failures) {
      console.error(`Integrated Archive attachment ${failure.originalPath}:`, failure.error);
    }
    const attachmentWarnings = result.attachments.filter((attachment) => attachment.historyError).length;
    if (result.primary.metadataError) console.error("Integrated Archive metadata:", result.primary.metadataError);
    if (result.primary.historyError) console.error("Integrated Archive history:", result.primary.historyError);
    const failed = this.failedParts(result.primary.metadataError, result.primary.historyError);
    const extras: string[] = [];
    if (result.attachments.length) {
      extras.push(`+ ${result.attachments.length} ${result.attachments.length === 1 ? "attachment" : "attachments"}`);
    }
    if (result.sharedSkipped.length) {
      extras.push(`${result.sharedSkipped.length} ${result.sharedSkipped.length === 1 ? "attachment" : "attachments"} left in place (shared or link index not ready)`);
    }
    if (result.failures.length) {
      extras.push(`${result.failures.length} ${result.failures.length === 1 ? "attachment" : "attachments"} failed`);
    }
    if (attachmentWarnings) {
      extras.push(`${attachmentWarnings} completed with warnings`);
    }
    const suffix = extras.length ? ` (${extras.join("; ")})` : "";
    if (failed) {
      new Notice(`Archived to ${result.primary.destination}${suffix}, but ${failed} could not be updated.`);
    } else {
      new Notice(`Archived to ${result.primary.destination}${suffix}`);
    }
  }

  private batchNotice(verb: string, succeeded: number, failed: number, warnings: number): string {
    const details = [failed && `${failed} failed`, warnings && `${warnings} completed with warnings`].filter(Boolean);
    const noun = succeeded === 1 ? "file" : "files";
    const suffix = details.length ? `; ${details.join("; ")}` : "";
    return `${verb} ${succeeded} ${noun}${suffix}.`;
  }

  private reportRestoreGroupResult(result: RestoreGroupResult): void {
    for (const failure of result.failures) {
      console.error(`Integrated Archive attachment restore ${failure.originalPath}:`, failure.error);
    }
    if (!result.attachments.length && !result.failures.length) {
      this.reportRestoreResult(result.primary);
      return;
    }
    const failed = this.failedParts(result.primary.metadataError, result.primary.historyError);
    if (result.primary.metadataError) console.error("Integrated Archive metadata restore:", result.primary.metadataError);
    if (result.primary.historyError) console.error("Integrated Archive history:", result.primary.historyError);
    const extras: string[] = [];
    if (result.attachments.length) {
      extras.push(`${result.attachments.length} ${result.attachments.length === 1 ? "attachment" : "attachments"}`);
    }
    if (result.failures.length) {
      extras.push(`${result.failures.length} failed`);
    }
    const destinations = [result.primary.destination, ...result.attachments.map((item) => item.destination)].join(", ");
    const suffix = failed ? `, but ${failed} could not be updated.` : ".";
    new Notice(`Restored ${extras.join(", ")} to ${destinations}${suffix}`);
  }

  private reportRestoreResult(result: Awaited<ReturnType<ArchiveManager<TFile>["restore"]>>): void {
    if (result.metadataError) console.error("Integrated Archive metadata restore:", result.metadataError);
    if (result.historyError) console.error("Integrated Archive history:", result.historyError);
    const failed = this.failedParts(result.metadataError, result.historyError);
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
  constructor(app: App, private readonly plugin: IntegratedArchivePlugin) {
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
            control: { type: "text", key: "archiveFolder", placeholder: "Archive", validate: (value) => validateArchiveFolder(value) ?? validateExcludedOverlap(value, s.excludedPaths) },
          },
          { name: "Preserve folder structure", desc: "Keep each file’s original folders inside the archive.", control: { type: "toggle", key: "preserveFolders" } },
          { name: "Clean up empty folders", desc: "Delete folders that become empty after archiving. Never deletes the vault root, the archive folder, or protected paths.", control: { type: "toggle", key: "cleanEmptyFolders" } },
          { name: "Archive linked attachments", desc: "When archiving a Markdown note, also archive images, PDFs, and other files it links to. Linked notes are never included.", control: { type: "toggle", key: "archiveAttachments" } },
          {
            name: "Include shared attachments",
            desc: "Also archive attachments linked from other notes. When off, attachments used elsewhere stay in place.",
            visible: () => s.archiveAttachments,
            control: { type: "toggle", key: "includeSharedAttachments" },
          },
          {
            name: "When deleting",
            desc: "Choose what happens to files outside the archive. Folders and archived files always use Obsidian’s normal delete flow.",
            control: { type: "dropdown", key: "deleteAction", options: { ask: "Ask every time", archive: "Archive automatically", delete: "Delete normally" } },
          },
          { name: "Show archive in file menus", desc: "Add Archive directly below Delete in file context menus.", control: { type: "toggle", key: "showArchiveMenu" } },
          {
            name: "Protected paths",
            desc: "One vault-relative path per line. Files and folders here are never archived, and restores into these paths are blocked.",
            control: { type: "textarea", key: "excludedPaths", placeholder: "Private\nTemplates", rows: 4, validate: (value) => validateExcludedPaths(value) ?? validateExcludedOverlap(s.archiveFolder, value) },
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
            desc: "Write the original location into archived Markdown notes so they can return home even if archive history is lost or synced to another device. Other file types rely on archive history (newest 200 records).",
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
