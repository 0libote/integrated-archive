import { addCollisionSuffix, isPathInFolder } from "./path";
import {
  MAX_ARCHIVE_HISTORY,
  normalizeTag,
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
  formatDate(timestamp: number, pattern: string): string;
  getArchiveHistory(): ArchiveRecord[];
  getEntryKind(path: string): VaultEntryKind | null;
  getFile(path: string): File | null;
  normalizePath(path: string): string;
  now(): number;
  processFrontMatter(file: File, update: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  renameFile(file: File, destination: string): Promise<void>;
  saveArchiveHistory(records: ArchiveRecord[]): Promise<void>;
}

export interface ArchiveResult {
  destination: string;
  historyError?: unknown;
  metadataError?: unknown;
  originalPath: string;
}

export interface RestoreResult {
  destination: string;
  historyError?: unknown;
  inferredOriginalPath: boolean;
  metadataError?: unknown;
}

export class ArchiveManager<File extends ArchiveFile> {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: ArchiveHost<File>,
    private readonly getSettings: () => ArchiveSettings,
  ) {}

  isArchived(file: File): boolean {
    const folder = this.archiveFolder();
    return (!!folder && folder !== "." && isPathInFolder(file.path, folder))
      || this.getHistory().some((record) => record.archivedPath === file.path);
  }

  archive(file: File): Promise<ArchiveResult> {
    return this.enqueue(() => this.archiveNow(file));
  }

  restore(file: File): Promise<RestoreResult> {
    return this.enqueue(() => this.restoreNow(file));
  }

  undoLastArchive(): Promise<RestoreResult> {
    return this.enqueue(async () => {
      const history = this.getHistory();
      for (let index = history.length - 1; index >= 0; index--) {
        const record = history[index];
        if (!record) continue;
        const file = this.host.getFile(record.archivedPath);
        if (file) return this.restoreNow(file);
      }
      throw new Error("There is no archived file to restore.");
    });
  }

  canUndo(): boolean {
    return this.getHistory().some((record) => !!this.host.getFile(record.archivedPath));
  }

  private async archiveNow(file: File): Promise<ArchiveResult> {
    const archiveFolder = this.archiveFolder();
    if (!archiveFolder || archiveFolder === ".") throw new Error("Choose an archive folder in settings.");
    if (isPathInFolder(file.path, archiveFolder)) throw new Error(`${file.name} is already archived.`);

    const originalPath = file.path;
    const created = file.stat.ctime;
    const modified = file.stat.mtime;
    const archivedAt = this.host.now();
    const relativePath = this.getSettings().preserveFolders ? file.path : file.name;
    const wantedPath = this.host.normalizePath(`${archiveFolder}/${relativePath}`);
    await this.ensureFolder(wantedPath.slice(0, wantedPath.lastIndexOf("/")));
    const destination = this.uniquePath(wantedPath);
    await this.host.renameFile(file, destination);

    let metadataError: unknown;
    let metadata: ArchiveMetadataSnapshot | undefined;
    try {
      metadata = await this.addMetadata(file, created, modified, archivedAt);
    } catch (error) {
      metadataError = error;
    }

    let historyError: unknown;
    try {
      await this.addHistory({ archivedAt, archivedPath: destination, metadata, originalPath });
    } catch (error) {
      historyError = error;
    }

    return { destination, historyError, metadataError, originalPath };
  }

  private async restoreNow(file: File): Promise<RestoreResult> {
    if (!this.isArchived(file)) throw new Error(`${file.name} is not archived.`);

    const history = this.getHistory();
    const recordIndex = this.findHistoryIndex(file.path, history);
    const record = recordIndex >= 0 ? history[recordIndex] : undefined;
    const originalPath = record?.originalPath ?? this.inferOriginalPath(file);
    const parent = originalPath.slice(0, originalPath.lastIndexOf("/"));
    await this.ensureFolder(parent);
    const destination = this.uniquePath(originalPath);
    await this.host.renameFile(file, destination);

    let metadataError: unknown;
    if (record?.metadata) {
      try {
        await this.restoreMetadata(file, record.metadata);
      } catch (error) {
        metadataError = error;
      }
    }

    let historyError: unknown;
    if (recordIndex >= 0) {
      history.splice(recordIndex, 1);
      try {
        await this.host.saveArchiveHistory(history);
      } catch (error) {
        historyError = error;
      }
    }

    return { destination, historyError, inferredOriginalPath: !record, metadataError };
  }

  private archiveFolder(): string {
    return this.host.normalizePath(this.getSettings().archiveFolder.trim());
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path) return;
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      const existing = this.host.getEntryKind(current);
      if (existing === "file") throw new Error(`${current} is a file, not a folder.`);
      if (!existing) await this.host.createFolder(current);
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
  ): Promise<ArchiveMetadataSnapshot | undefined> {
    if (file.extension !== "md") return undefined;
    const settings = this.getSettings();
    if (!settings.addTag && !settings.addArchivedDate && !settings.addCreatedDate && !settings.addModifiedDate) return undefined;

    const snapshot: ArchiveMetadataSnapshot = { properties: [] };

    await this.host.processFrontMatter(file, (frontmatter) => {
      if (settings.addTag && settings.tag.trim()) {
        const tag = normalizeTag(settings.tag);
        const tags = Array.isArray(frontmatter.tags)
          ? frontmatter.tags.map((value: unknown) => String(value))
          : typeof frontmatter.tags === "string"
            ? frontmatter.tags.split(/[ ,]+/).filter(Boolean)
            : [];
        if (tag && !tags.some((existing) => normalizeTag(existing) === tag)) {
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
    });
    return snapshot.properties.length ? snapshot : undefined;
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
    if (existed) property.value = frontmatter[key];
    snapshot.properties.push(property);
  }

  private async restoreMetadata(file: File, snapshot: ArchiveMetadataSnapshot): Promise<void> {
    if (file.extension !== "md" || !snapshot.properties.length) return;
    await this.host.processFrontMatter(file, (frontmatter) => {
      for (const property of snapshot.properties) {
        if (property.existed) frontmatter[property.key] = property.value;
        else delete frontmatter[property.key];
      }
    });
  }

  private getHistory(): ArchiveRecord[] {
    return [...this.host.getArchiveHistory()];
  }

  private async addHistory(record: ArchiveRecord): Promise<void> {
    const records = this.getHistory().filter((item) => item.archivedPath !== record.archivedPath);
    records.push(record);
    await this.host.saveArchiveHistory(records.slice(-MAX_ARCHIVE_HISTORY));
  }

  private inferOriginalPath(file: File): string {
    const archiveFolder = this.archiveFolder();
    if (this.getSettings().preserveFolders && isPathInFolder(file.path, archiveFolder)) {
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
