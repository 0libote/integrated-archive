import { addCollisionSuffix, isPathInFolder, parentFolder } from "./path";
import {
  MAX_ARCHIVE_HISTORY,
  normalizeTag,
  parseExcludedPaths,
  type ArchiveMetadataSnapshot,
  type ArchivePropertySnapshot,
  type ArchiveRecord,
  type ArchiveSettings,
} from "./settings";

export interface ArchiveFile {
  extension: string;
  name: string;
  path: string;
  stat: {
    ctime: number;
    mtime: number;
  };
}

export type VaultEntryKind = "file" | "folder";

export interface ArchiveHost<File extends ArchiveFile> {
  createFolder(path: string): Promise<void>;
  deleteFolder(path: string): Promise<void>;
  formatDate(timestamp: number, pattern: string): string;
  getArchiveHistory(): ArchiveRecord[];
  getEntryKind(path: string): VaultEntryKind | null;
  getFile(path: string): File | null;
  getFolderChildren(path: string): string[] | null;
  getFrontmatter(file: File): Promise<Record<string, unknown> | undefined>;
  listIncomingLinks(destPath: string): string[];
  listOutgoingLinks(sourcePath: string): string[];
  normalizePath(path: string): string;
  now(): number;
  processFrontMatter(file: File, update: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  renameFile(file: File, destination: string): Promise<void>;
  saveArchiveHistory(records: ArchiveRecord[]): Promise<void>;
}

export interface ArchiveResult {
  cleanedFolders: string[];
  destination: string;
  historyError?: unknown;
  metadataError?: unknown;
  originalPath: string;
}

export interface ArchivedAttachment {
  destination: string;
  historyError?: unknown;
  originalPath: string;
}

export interface AttachmentFailure {
  error: unknown;
  originalPath: string;
}

export interface AttachmentPlan<T extends ArchiveFile> {
  attachments: T[];
  sharedSkipped: string[];
}

export interface ArchiveGroupResult {
  attachments: ArchivedAttachment[];
  failures: AttachmentFailure[];
  groupId?: string;
  primary: ArchiveResult;
  sharedSkipped: string[];
}

export interface RestoreGroupResult {
  attachments: RestoreResult[];
  failures: AttachmentFailure[];
  groupId?: string;
  primary: RestoreResult;
}

export interface ArchiveOptions {
  groupId?: string;
}

export interface RestoreResult {
  destination: string;
  historyError?: unknown;
  inferredOriginalPath: boolean;
  metadataError?: unknown;
}

export class ArchiveManager<File extends ArchiveFile> {
  private operationQueue: Promise<void> = Promise.resolve();
  private groupCounter = 0;
  private excludedCache: { raw: string; parsed: string[] } | null = null;

  constructor(
    private readonly host: ArchiveHost<File>,
    private readonly getSettings: () => ArchiveSettings,
  ) {}

  isArchived(file: File): boolean {
    return this.isArchivedPath(file.path);
  }

  isArchivedPath(path: string): boolean {
    const folder = this.archiveFolder();
    return (!!folder && folder !== "." && isPathInFolder(path, folder))
      || this.getHistory().some((record) => record.archivedPath === path);
  }

  isExcludedPath(path: string): boolean {
    const raw = this.getSettings().excludedPaths;
    let parsed = this.excludedCache?.raw === raw ? this.excludedCache.parsed : null;
    if (!parsed) {
      parsed = parseExcludedPaths(raw);
      this.excludedCache = { parsed, raw };
    }
    return parsed.some((excluded) => isPathInFolder(path, excluded));
  }

  archive(file: File, options?: ArchiveOptions): Promise<ArchiveResult> {
    return this.enqueue(() => this.archiveNow(file, options?.groupId));
  }

  archiveWithAttachments(file: File): Promise<ArchiveGroupResult> {
    return this.enqueue(() => this.archiveGroupNow(file));
  }

  restore(file: File): Promise<RestoreResult> {
    return this.enqueue(() => this.restoreNow(file));
  }

  restoreWithGroup(file: File): Promise<RestoreGroupResult> {
    return this.enqueue(() => this.restoreGroupNow(file));
  }

  reconcileRename(oldPath: string, newPath: string): Promise<void> {
    return this.enqueue(() => this.reconcileRenameNow(oldPath, newPath));
  }

  undoLastArchive(): Promise<RestoreResult> {
    return this.enqueue(async () => {
      const history = this.getHistory();
      for (let index = history.length - 1; index >= 0; index--) {
        const record = history[index];
        if (!record) continue;
        const file = this.host.getFile(record.archivedPath);
        if (!file) continue;
        // Never split a group: a grouped record restores with its group and
        // only the primary result is returned to keep this signature.
        if (record.groupId) {
          const members = history.filter((item) => item.groupId === record.groupId);
          for (const member of members) {
            const memberFile = this.host.getFile(member.archivedPath);
            if (memberFile) return (await this.restoreGroupFromRecord(memberFile, record.groupId)).primary;
          }
          continue;
        }
        if (file) return this.restoreNow(file);
      }
      throw new Error("There is no archived file to restore.");
    });
  }

  undoLastArchiveGroup(): Promise<RestoreGroupResult> {
    return this.enqueue(async () => {
      const history = this.getHistory();
      for (let index = history.length - 1; index >= 0; index--) {
        const record = history[index];
        if (!record) continue;
        const file = this.host.getFile(record.archivedPath);
        if (!file) continue;
        if (!record.groupId) {
          return { attachments: [], failures: [], groupId: undefined, primary: await this.restoreNow(file) };
        }
        // Restore the group starting from its oldest available member so the
        // note (archived first) is the primary result.
        const members = history.filter((item) => item.groupId === record.groupId);
        for (const member of members) {
          const memberFile = this.host.getFile(member.archivedPath);
          if (memberFile) return this.restoreGroupFromRecord(memberFile, record.groupId);
        }
      }
      throw new Error("There is no archived file to restore.");
    });
  }

  makeGroupId(sourcePath: string): string {
    this.groupCounter += 1;
    return `${this.host.now()}:${sourcePath}:${this.groupCounter}:${Math.random().toString(36).slice(2, 8)}`;
  }

  getRecordGroup(archivedPath: string): string | undefined {
    return this.getHistory().find((record) => record.archivedPath === archivedPath)?.groupId;
  }

  listGroupArchivedPaths(groupId: string): string[] {
    if (!groupId) return [];
    return this.getHistory()
      .filter((record) => record.groupId === groupId)
      .map((record) => record.archivedPath);
  }

  async collectAttachments(file: File, incomingCache?: Map<string, string[]>): Promise<AttachmentPlan<File>> {
    const attachments: File[] = [];
    const sharedSkipped: string[] = [];
    const settings = this.getSettings();
    if (!settings.archiveAttachments) return { attachments, sharedSkipped };
    if (file.extension !== "md") return { attachments, sharedSkipped };

    let outgoing: string[];
    try {
      outgoing = this.host.listOutgoingLinks(file.path);
    } catch {
      return { attachments, sharedSkipped };
    }
    const seen = new Set<string>([file.path]);
    for (const destination of outgoing) {
      if (seen.has(destination)) continue;
      seen.add(destination);
      const candidate = this.host.getFile(destination);
      if (!candidate || candidate.path === file.path) continue;
      // Linked notes stay notes: only non-note files travel with the note.
      if (candidate.extension === "md" || candidate.extension === "canvas") continue;
      if (this.isArchivedPath(candidate.path)) continue;
      if (this.isExcludedPath(candidate.path)) continue;
      if (!settings.includeSharedAttachments && this.isSharedAttachment(candidate.path, file.path, incomingCache)) {
        sharedSkipped.push(candidate.path);
        continue;
      }
      attachments.push(candidate);
    }
    return { attachments, sharedSkipped };
  }

  private isSharedAttachment(destination: string, sourcePath: string, incomingCache?: Map<string, string[]>): boolean {
    let referrers: string[];
    try {
      const cached = incomingCache?.get(destination);
      if (cached) {
        referrers = cached;
      } else {
        referrers = this.host.listIncomingLinks(destination);
        incomingCache?.set(destination, referrers);
      }
    } catch {
      // Without a link index we cannot prove exclusivity, so keep the file.
      return true;
    }
    for (const referrer of referrers) {
      if (referrer === sourcePath) continue;
      if (this.isArchivedPath(referrer)) continue;
      if (this.host.getFile(referrer)) return true;
    }
    return false;
  }

  canUndo(): boolean {
    return this.getHistory().some((record) => !!this.host.getFile(record.archivedPath));
  }

  private async archiveNow(file: File, groupId?: string): Promise<ArchiveResult> {
    const archiveFolder = this.archiveFolder();
    if (!archiveFolder || archiveFolder === ".") throw new Error("Choose an archive folder in settings.");
    if (isPathInFolder(file.path, archiveFolder)) throw new Error(`${file.name} is already archived.`);
    if (this.isExcludedPath(file.path)) throw new Error(`${file.name} is in a protected location.`);
    if (this.getHistory().some((record) => record.archivedPath === file.path)) {
      throw new Error(`${file.name} is already archived.`);
    }

    const originalPath = file.path;
    const created = file.stat.ctime;
    const modified = file.stat.mtime;
    const archivedAt = this.host.now();
    const relativePath = this.getSettings().preserveFolders ? file.path : file.name;
    const wantedPath = this.host.normalizePath(`${archiveFolder}/${relativePath}`);
    if (this.isExcludedPath(wantedPath)) {
      throw new Error(`Cannot archive ${file.name}: the archive folder is inside a protected location.`);
    }
    await this.ensureFolder(wantedPath.slice(0, wantedPath.lastIndexOf("/")));
    const destination = this.uniquePath(wantedPath);
    if (this.isExcludedPath(destination)) {
      throw new Error(`Cannot archive ${file.name}: the archive folder is inside a protected location.`);
    }
    await this.host.renameFile(file, destination);

    let metadataError: unknown;
    let metadata: ArchiveMetadataSnapshot | undefined;
    try {
      metadata = await this.addMetadata(file, created, modified, archivedAt, originalPath);
    } catch (error) {
      metadataError = error;
    }

    let historyError: unknown;
    try {
      await this.addHistory({ archivedAt, archivedPath: destination, metadata, originalPath, ...(groupId ? { groupId } : {}) });
    } catch (error) {
      historyError = error;
    }

    const cleanedFolders = await this.cleanupEmptyParents(originalPath);

    return { cleanedFolders, destination, historyError, metadataError, originalPath };
  }

  private async archiveGroupNow(file: File): Promise<ArchiveGroupResult> {
    const plan = await this.collectAttachments(file);
    if (!plan.attachments.length) {
      return {
        attachments: [],
        failures: [],
        groupId: undefined,
        primary: await this.archiveNow(file),
        sharedSkipped: plan.sharedSkipped,
      };
    }
    const groupId = this.makeGroupId(file.path);
    const primary = await this.archiveNow(file, groupId);
    const attachments: ArchivedAttachment[] = [];
    const failures: AttachmentFailure[] = [];
    for (const attachment of plan.attachments) {
      const current = this.host.getFile(attachment.path);
      if (!current) {
        failures.push({ error: new Error(`${attachment.path} is no longer available.`), originalPath: attachment.path });
        continue;
      }
      try {
        const result = await this.archiveNow(current, groupId);
        attachments.push({ destination: result.destination, historyError: result.historyError, originalPath: result.originalPath });
      } catch (error) {
        failures.push({ error, originalPath: current.path });
      }
    }
    return { attachments, failures, groupId, primary, sharedSkipped: plan.sharedSkipped };
  }

  private async restoreGroupNow(file: File): Promise<RestoreGroupResult> {
    const record = this.getHistory().find((item) => item.archivedPath === file.path);
    if (!record?.groupId) {
      return { attachments: [], failures: [], groupId: undefined, primary: await this.restoreNow(file) };
    }
    return this.restoreGroupFromRecord(file, record.groupId);
  }

  private async restoreGroupFromRecord(file: File, groupId: string): Promise<RestoreGroupResult> {
    // Try the requested file first, then every fellow member. The first file
    // that restores becomes the primary so one blocked file cannot strand
    // the rest of its group.
    const queued = [file.path, ...this.getHistory()
      .filter((record) => record.groupId === groupId)
      .map((record) => record.archivedPath)];
    const seen = new Set<string>();
    const succeeded: RestoreResult[] = [];
    const failures: AttachmentFailure[] = [];
    for (const archivedPath of queued) {
      if (seen.has(archivedPath)) continue;
      seen.add(archivedPath);
      const memberFile = this.host.getFile(archivedPath);
      if (!memberFile) continue;
      try {
        succeeded.push(await this.restoreNow(memberFile));
      } catch (error) {
        failures.push({ error, originalPath: archivedPath });
      }
    }
    const [primary, ...attachments] = succeeded;
    if (!primary) {
      const first = failures[0]?.error;
      if (first instanceof Error) throw first;
      throw new Error("There is no archived file to restore.");
    }
    return { attachments, failures, groupId, primary };
  }

  private async cleanupEmptyParents(originalPath: string): Promise<string[]> {
    const cleaned: string[] = [];
    if (!this.getSettings().cleanEmptyFolders) return cleaned;
    const archiveFolder = this.archiveFolder();
    let current = parentFolder(originalPath);
    while (current) {
      // Never delete the archive folder itself, anything inside it, or an
      // ancestor that contains it (such a folder cannot be empty anyway, but
      // guard explicitly so cleanup can never remove the archive's parent).
      if (!!archiveFolder && archiveFolder !== "."
        && (current === archiveFolder || isPathInFolder(current, archiveFolder) || isPathInFolder(archiveFolder, current))) {
        break;
      }
      // Never delete a protected location, even when it becomes empty.
      if (this.isExcludedPath(current)) break;
      let children: string[] | null;
      try {
        children = this.host.getFolderChildren(current);
      } catch {
        break;
      }
      if (children?.length !== 0) break;
      try {
        await this.host.deleteFolder(current);
      } catch {
        break;
      }
      cleaned.push(current);
      current = parentFolder(current);
    }
    return cleaned;
  }

  private async restoreNow(file: File): Promise<RestoreResult> {
    if (!this.isArchived(file)) throw new Error(`${file.name} is not archived.`);

    const history = this.getHistory();
    const recordIndex = this.findHistoryIndex(file.path, history);
    const record = recordIndex >= 0 ? history[recordIndex] : undefined;
    const { fromStoredPath, inferredProperty, originalPath } = await this.resolveRestorePath(file, record);

    if (this.isExcludedPath(originalPath)) {
      throw new Error(`Cannot restore ${file.name}: ${originalPath} is in a protected location.`);
    }
    const parent = parentFolder(originalPath);
    await this.ensureFolder(parent);
    const destination = this.uniquePath(originalPath);
    await this.host.renameFile(file, destination);

    const metadataError = await this.revertMetadata(file, record, inferredProperty);

    let historyError: unknown;
    if (recordIndex >= 0) {
      history.splice(recordIndex, 1);
      try {
        await this.host.saveArchiveHistory(history);
      } catch (error) {
        historyError = error;
      }
    }

    return { destination, historyError, inferredOriginalPath: !record && !fromStoredPath, metadataError };
  }

  private async resolveRestorePath(
    file: File,
    record: ArchiveRecord | undefined,
  ): Promise<{ fromStoredPath?: boolean; inferredProperty?: string; originalPath: string }> {
    // Saved history is trusted for metadata but not blindly for the path: it
    // may predate an archive-folder change or come from synced data. Reuse
    // the same strict check as stored frontmatter paths, except a path that
    // became protected must still surface (restoreNow throws) instead of
    // silently redirecting elsewhere.
    if (record?.originalPath) {
      if (this.isExcludedPath(record.originalPath)) return { originalPath: record.originalPath };
      if (this.isValidOriginalPath(record.originalPath)) return { originalPath: record.originalPath };
    }

    const property = this.getSettings().originalPathProperty.trim();
    const stored = property ? await this.readOriginalPathProperty(file, property) : undefined;
    if (stored && this.isValidOriginalPath(stored)) {
      return { fromStoredPath: true, inferredProperty: property, originalPath: stored };
    }

    return { originalPath: this.inferOriginalPath(file) };
  }

  private async revertMetadata(
    file: File,
    record: ArchiveRecord | undefined,
    inferredProperty: string | undefined,
  ): Promise<unknown> {
    let metadataError: unknown;
    if (record?.metadata) {
      try {
        await this.restoreMetadata(file, record.metadata);
      } catch (error) {
        metadataError = error;
      }
    }
    if (inferredProperty) {
      try {
        await this.host.processFrontMatter(file, (frontmatter) => {
          delete frontmatter[inferredProperty];
        });
      } catch (error) {
        metadataError ??= error;
      }
    }
    return metadataError;
  }

  private async readOriginalPathProperty(file: File, property: string): Promise<string | undefined> {
    const frontmatter = await this.host.getFrontmatter(file);
    const value = frontmatter?.[property];
    return typeof value === "string" ? value : undefined;
  }

  private isValidOriginalPath(path: string): boolean {
    const candidate = path.trim();
    if (!candidate || candidate.startsWith("/") || candidate.includes("\\")) return false;
    if (candidate.split("/").some((part) => !part || part === "." || part === "..")) return false;
    const folder = this.archiveFolder();
    if (folder && folder !== "." && isPathInFolder(candidate, folder)) return false;
    // Never restore into a protected location; fall back to inference instead.
    if (this.isExcludedPath(candidate)) return false;
    return true;
  }

  private async reconcileRenameNow(oldPath: string, newPath: string): Promise<void> {
    if (!oldPath || oldPath === newPath) return;
    const folder = this.archiveFolder();
    const folderConfigured = !!folder && folder !== ".";
    // Renaming the archive folder itself (or one of its ancestors) moves
    // archived files with it. Keep tracking them at the new location instead
    // of dropping their history; only drop records when an archived item is
    // moved out of a still-configured archive folder.
    const archiveMoved = folderConfigured && (oldPath === folder || isPathInFolder(folder, oldPath));
    const staysArchived = folderConfigured && isPathInFolder(newPath, folder);
    const history = this.getHistory();
    let changed = false;
    const kept: ArchiveRecord[] = [];
    for (const record of history) {
      if (record.archivedPath === oldPath || isPathInFolder(record.archivedPath, oldPath)) {
        changed = true;
        if (staysArchived || archiveMoved || !folderConfigured) {
          const suffix = record.archivedPath.slice(oldPath.length);
          kept.push({ ...record, archivedPath: `${newPath}${suffix}` });
        }
        continue;
      }
      kept.push(record);
    }
    if (changed) await this.host.saveArchiveHistory(kept);
  }

  private archiveFolder(): string {
    return this.host.normalizePath(this.getSettings().archiveFolder.trim());
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path) return;
    let current = "";
    // Sequential by design: each level depends on its parent existing.
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      const existing = this.host.getEntryKind(current);
      if (existing === "file") throw new Error(`${current} is a file, not a folder.`);
      if (!existing) await this.host.createFolder(current); // NOSONAR typescript:S9382
    }
  }

  private uniquePath(path: string): string {
    let number = 0;
    while (this.host.getEntryKind(addCollisionSuffix(path, number))) number++;
    return addCollisionSuffix(path, number);
  }

  private async addMetadata(
    file: File,
    created: number,
    modified: number,
    archivedAt: number,
    originalPath: string,
  ): Promise<ArchiveMetadataSnapshot | undefined> {
    if (file.extension !== "md") return undefined;
    const settings = this.getSettings();
    if (!settings.addTag && !settings.addArchivedDate && !settings.addCreatedDate
      && !settings.addModifiedDate && !settings.storeOriginalPath) return undefined;

    const snapshot: ArchiveMetadataSnapshot = { properties: [] };

    await this.host.processFrontMatter(file, (frontmatter) => {
      if (settings.addTag && settings.tag.trim()) {
        const tag = normalizeTag(settings.tag);
        const tags = this.readTags(frontmatter.tags);
        if (tag && !tags.some((existing) => normalizeTag(existing)?.toLowerCase() === tag.toLowerCase())) {
          this.captureProperty(snapshot, frontmatter, "tags");
          frontmatter.tags = [...tags, tag];
        }
      }
      const format = (timestamp: number) => this.host.formatDate(timestamp, settings.dateFormat || DEFAULT_DATE_FORMAT);
      if (settings.addArchivedDate && settings.archivedProperty.trim()) {
        const property = settings.archivedProperty.trim();
        this.captureProperty(snapshot, frontmatter, property);
        frontmatter[property] = format(archivedAt);
      }
      if (settings.addCreatedDate && settings.createdProperty.trim()) {
        this.setHistoricalDate(snapshot, frontmatter, settings.createdProperty.trim(), format(created));
      }
      if (settings.addModifiedDate && settings.modifiedProperty.trim()) {
        this.setHistoricalDate(snapshot, frontmatter, settings.modifiedProperty.trim(), format(modified));
      }
      if (settings.storeOriginalPath && settings.originalPathProperty.trim()) {
        const property = settings.originalPathProperty.trim();
        this.captureProperty(snapshot, frontmatter, property);
        frontmatter[property] = originalPath;
      }
      for (const property of snapshot.properties) {
        property.archivedValue = cloneValue(frontmatter[property.key]);
      }
    });
    return snapshot.properties.length ? snapshot : undefined;
  }

  private readTags(value: unknown): string[] {
    let raw: string[];
    if (Array.isArray(value)) {
      raw = value.map((tag) => String(tag).trim());
    } else if (typeof value === "string") {
      raw = value.split(/[ ,]+/).filter(Boolean);
    } else {
      raw = [];
    }
    // Strip leading "#" markers so stored tags stay consistent ("#foo" and
    // "foo" are the same tag). Invalid leftovers are dropped.
    return raw.map((tag) => tag.replace(/^#+/, "").trim()).filter(Boolean);
  }

  private setHistoricalDate(
    snapshot: ArchiveMetadataSnapshot,
    frontmatter: Record<string, unknown>,
    property: string,
    value: string,
  ): void {
    if (this.getSettings().existingDateAction === "overwrite"
      || !Object.prototype.hasOwnProperty.call(frontmatter, property)) {
      this.captureProperty(snapshot, frontmatter, property);
      frontmatter[property] = value;
    }
  }

  private captureProperty(
    snapshot: ArchiveMetadataSnapshot,
    frontmatter: Record<string, unknown>,
    key: string,
  ): void {
    if (snapshot.properties.some((property) => property.key === key)) return;
    const existed = Object.prototype.hasOwnProperty.call(frontmatter, key);
    const property: ArchivePropertySnapshot = { existed, key };
    // Clone objects so later frontmatter edits can't mutate the restore snapshot.
    if (existed) property.value = cloneValue(frontmatter[key]);
    snapshot.properties.push(property);
  }

  private async restoreMetadata(file: File, snapshot: ArchiveMetadataSnapshot): Promise<void> {
    if (file.extension !== "md" || !snapshot.properties.length) return;
    await this.host.processFrontMatter(file, (frontmatter) => {
      for (const property of snapshot.properties) {
        this.restoreProperty(frontmatter, property);
      }
    });
  }

  private restoreProperty(frontmatter: Record<string, unknown>, property: ArchivePropertySnapshot): void {
    if (this.hasDivergedFromArchive(frontmatter, property)) {
      // The value changed while archived: remove only the tag introduced by
      // archiving, preserving later edits. Other properties keep user edits.
      this.removeAddedTags(frontmatter, property);
      return;
    }
    if (property.existed) frontmatter[property.key] = cloneValue(property.value);
    else delete frontmatter[property.key];
  }

  private hasDivergedFromArchive(
    frontmatter: Record<string, unknown>,
    property: ArchivePropertySnapshot,
  ): boolean {
    return Object.prototype.hasOwnProperty.call(property, "archivedValue")
      && !valuesEqual(frontmatter[property.key], property.archivedValue);
  }

  private removeAddedTags(frontmatter: Record<string, unknown>, property: ArchivePropertySnapshot): void {
    if (property.key !== "tags") return;
    const currentTags = frontmatter.tags;
    if (!Array.isArray(currentTags) && typeof currentTags !== "string") return;
    if (!Array.isArray(property.archivedValue)) return;
    const originalTagSet = new Set(this.readTags(property.value).map((tag) => tag.toLowerCase()));
    const addedTagSet = new Set(
      this.readTags(property.archivedValue)
        .filter((tag) => !originalTagSet.has(tag.toLowerCase()))
        .map((tag) => tag.toLowerCase()),
    );
    if (addedTagSet.size === 0) return;
    const tags = Array.isArray(currentTags) ? currentTags : this.readTags(currentTags);
    const remaining = tags.filter(
      (tag) => !addedTagSet.has(normalizeTag(String(tag))?.toLowerCase() ?? ""),
    );
    frontmatter.tags = typeof currentTags === "string" ? remaining.join(" ") : remaining;
  }

  private getHistory(): ArchiveRecord[] {
    return [...this.host.getArchiveHistory()];
  }

  private async addHistory(record: ArchiveRecord): Promise<void> {
    const records = this.getHistory().filter((item) => item.archivedPath !== record.archivedPath);
    records.push(record);
    if (records.length <= MAX_ARCHIVE_HISTORY) {
      await this.host.saveArchiveHistory(records);
      return;
    }
    // Over the cap: evict records for files that no longer exist first so
    // live restores keep their way home as long as possible.
    const missing: number[] = [];
    records.forEach((item, index) => {
      if (!this.host.getFile(item.archivedPath)) missing.push(index);
    });
    let trimmed = [...records];
    // Remove oldest missing-file records until we fit.
    for (let i = missing.length - 1; i >= 0 && trimmed.length > MAX_ARCHIVE_HISTORY; i--) {
      const at = missing[i];
      if (at !== undefined) trimmed = [...trimmed.slice(0, at), ...trimmed.slice(at + 1)];
    }
    if (trimmed.length > MAX_ARCHIVE_HISTORY) {
      console.warn(`Integrated Archive: history over ${MAX_ARCHIVE_HISTORY} records; oldest entry dropped.`);
      trimmed = trimmed.slice(-MAX_ARCHIVE_HISTORY);
    }
    await this.host.saveArchiveHistory(trimmed);
  }

  private inferOriginalPath(file: File): string {
    const archiveFolder = this.archiveFolder();
    // Strip the archive prefix whenever the file is inside the archive folder,
    // regardless of the preserveFolders setting. That setting only controls
    // where new archives are placed, not where legacy files came from.
    if (!!archiveFolder && archiveFolder !== "." && isPathInFolder(file.path, archiveFolder)) {
      const relative = file.path.slice(archiveFolder.length + 1);
      if (relative) return relative;
    }
    return file.name;
  }

  private findHistoryIndex(path: string, history: ArchiveRecord[]): number {
    for (let index = history.length - 1; index >= 0; index--) {
      if (history[index]?.archivedPath === path) return index;
    }
    return -1;
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";

function cloneValue<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  return structuredClone(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && valuesEqual(a[key], b[key]));
}
