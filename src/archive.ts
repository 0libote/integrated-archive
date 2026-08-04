import { addCollisionSuffix, isPathInFolder } from "./path";
import { normalizeTag, type ArchiveSettings } from "./settings";

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
  getEntryKind(path: string): VaultEntryKind | null;
  normalizePath(path: string): string;
  now(): number;
  processFrontMatter(file: File, update: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  renameFile(file: File, destination: string): Promise<void>;
}

export interface ArchiveResult {
  destination: string;
  metadataError?: unknown;
}

export class ArchiveManager<File extends ArchiveFile> {
  constructor(
    private readonly host: ArchiveHost<File>,
    private readonly getSettings: () => ArchiveSettings,
  ) {}

  isArchived(file: File): boolean {
    const folder = this.archiveFolder();
    return !!folder && folder !== "." && isPathInFolder(file.path, folder);
  }

  async archive(file: File): Promise<ArchiveResult> {
    const archiveFolder = this.archiveFolder();
    if (!archiveFolder || archiveFolder === ".") throw new Error("Choose an archive folder in settings.");
    if (isPathInFolder(file.path, archiveFolder)) throw new Error(`${file.name} is already archived.`);

    const created = file.stat.ctime;
    const modified = file.stat.mtime;
    const relativePath = this.getSettings().preserveFolders ? file.path : file.name;
    const wantedPath = this.host.normalizePath(`${archiveFolder}/${relativePath}`);
    await this.ensureFolder(wantedPath.slice(0, wantedPath.lastIndexOf("/")));
    const destination = this.uniquePath(wantedPath);
    await this.host.renameFile(file, destination);

    try {
      await this.addMetadata(file, created, modified);
      return { destination };
    } catch (metadataError) {
      return { destination, metadataError };
    }
  }

  private archiveFolder(): string {
    return this.host.normalizePath(this.getSettings().archiveFolder.trim());
  }

  private async ensureFolder(path: string): Promise<void> {
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

  private async addMetadata(file: File, created: number, modified: number): Promise<void> {
    if (file.extension !== "md") return;
    const settings = this.getSettings();
    if (!settings.addTag && !settings.addArchivedDate && !settings.addCreatedDate && !settings.addModifiedDate) return;

    await this.host.processFrontMatter(file, (frontmatter) => {
      if (settings.addTag && settings.tag.trim()) {
        const tag = normalizeTag(settings.tag);
        const tags = Array.isArray(frontmatter.tags)
          ? frontmatter.tags.map((value: unknown) => String(value))
          : typeof frontmatter.tags === "string"
            ? frontmatter.tags.split(/[ ,]+/).filter(Boolean)
            : [];
        if (tag) frontmatter.tags = [...new Set([...tags, tag])];
      }
      const format = (timestamp: number) => this.host.formatDate(timestamp, settings.dateFormat || DEFAULT_DATE_FORMAT);
      if (settings.addArchivedDate && settings.archivedProperty.trim()) {
        frontmatter[settings.archivedProperty.trim()] = format(this.host.now());
      }
      if (settings.addCreatedDate && settings.createdProperty.trim()) {
        this.setHistoricalDate(frontmatter, settings.createdProperty.trim(), format(created));
      }
      if (settings.addModifiedDate && settings.modifiedProperty.trim()) {
        this.setHistoricalDate(frontmatter, settings.modifiedProperty.trim(), format(modified));
      }
    });
  }

  private setHistoricalDate(frontmatter: Record<string, unknown>, property: string, value: string): void {
    if (this.getSettings().existingDateAction === "overwrite"
      || !Object.prototype.hasOwnProperty.call(frontmatter, property)) {
      frontmatter[property] = value;
    }
  }
}

const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
