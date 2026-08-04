import type { DeleteAction } from "./path";
import { resolveDeleteAction } from "./path";

export type ExistingDateAction = "preserve" | "overwrite";
export type DatePropertyKey = "archivedProperty" | "createdProperty" | "modifiedProperty";

export interface ArchiveRecord {
  archivedAt: number;
  archivedPath: string;
  originalPath: string;
}

export interface ArchiveSettings {
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
  existingDateAction: ExistingDateAction;
}

export interface ArchiveData extends ArchiveSettings {
  archiveHistory: ArchiveRecord[];
}

export const DEFAULT_SETTINGS: ArchiveSettings = {
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
  existingDateAction: "preserve",
};

export const DEFAULT_DATA: ArchiveData = {
  ...DEFAULT_SETTINGS,
  archiveHistory: [],
};

const BOOLEAN_KEYS = [
  "preserveFolders",
  "showArchiveMenu",
  "addTag",
  "addArchivedDate",
  "addCreatedDate",
  "addModifiedDate",
] as const;

const STRING_KEYS = [
  "archiveFolder",
  "tag",
  "archivedProperty",
  "createdProperty",
  "modifiedProperty",
  "dateFormat",
] as const;

export function sanitizeSettings(value: unknown): ArchiveSettings {
  const stored = isRecord(value) ? value : {};
  const settings = { ...DEFAULT_SETTINGS };

  for (const key of BOOLEAN_KEYS) {
    if (typeof stored[key] === "boolean") settings[key] = stored[key];
  }
  for (const key of STRING_KEYS) {
    if (typeof stored[key] === "string") settings[key] = stored[key].trim();
  }

  settings.deleteAction = resolveDeleteAction(
    typeof stored.deleteAction === "string" ? stored.deleteAction : undefined,
    typeof stored.promptOnDelete === "boolean" ? stored.promptOnDelete : undefined,
  );
  settings.existingDateAction = stored.existingDateAction === "overwrite" ? "overwrite" : "preserve";

  if (validateArchiveFolder(settings.archiveFolder)) settings.archiveFolder = DEFAULT_SETTINGS.archiveFolder;
  settings.tag = normalizeTag(settings.tag) ?? DEFAULT_SETTINGS.tag;
  if (!settings.archivedProperty) settings.archivedProperty = DEFAULT_SETTINGS.archivedProperty;
  if (!settings.createdProperty) settings.createdProperty = DEFAULT_SETTINGS.createdProperty;
  if (!settings.modifiedProperty) settings.modifiedProperty = DEFAULT_SETTINGS.modifiedProperty;
  if (!settings.dateFormat) settings.dateFormat = DEFAULT_SETTINGS.dateFormat;
  repairDuplicateDateProperties(settings);

  return settings;
}

export function sanitizeData(value: unknown): ArchiveData {
  const settings = sanitizeSettings(value);
  const stored = isRecord(value) && Array.isArray(value.archiveHistory) ? value.archiveHistory : [];
  const archiveHistory = stored.filter(isArchiveRecord).slice(-MAX_ARCHIVE_HISTORY);
  return { ...settings, archiveHistory };
}

export function normalizeTag(value: string): string | null {
  const tag = value.trim().replace(/^#+/, "");
  return validateTag(tag) ? null : tag;
}

export function validateArchiveFolder(value: string): string | undefined {
  const folder = value.trim();
  if (!folder || folder === ".") return "Enter an archive folder.";
  if (folder.startsWith("/") || folder.includes("\\")) return "Use a path relative to the vault root with forward slashes.";
  if (folder.split("/").some((part) => !part || part === "." || part === "..")) {
    return "Use folder names without empty, . or .. path segments.";
  }
  return undefined;
}

export function validateTag(value: string): string | undefined {
  const tag = value.trim().replace(/^#+/, "");
  if (!tag) return "Enter a tag.";
  if (/\s|[,#]/.test(tag)) return "Tags cannot contain spaces, commas, or # characters.";
  if (!/[^0-9]/.test(tag)) return "Tags must contain at least one non-numeric character.";
  return undefined;
}

export function validatePropertyName(value: string): string | undefined {
  if (!value.trim()) return "Enter a property name.";
  if (/\r|\n/.test(value)) return "Property names must fit on one line.";
  return undefined;
}

export function validateDateProperty(
  settings: ArchiveSettings,
  key: DatePropertyKey,
  value: string,
): string | undefined {
  const invalidName = validatePropertyName(value);
  if (invalidName) return invalidName;

  const candidate = value.trim();
  for (const otherKey of DATE_PROPERTY_KEYS) {
    if (otherKey !== key && isDateEnabled(settings, otherKey) && settings[otherKey].trim() === candidate) {
      return "Use a unique name for each enabled date property.";
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArchiveRecord(value: unknown): value is ArchiveRecord {
  return isRecord(value)
    && typeof value.archivedAt === "number"
    && Number.isFinite(value.archivedAt)
    && typeof value.archivedPath === "string"
    && !!value.archivedPath
    && typeof value.originalPath === "string"
    && !!value.originalPath;
}

export const MAX_ARCHIVE_HISTORY = 200;

const DATE_PROPERTY_KEYS: DatePropertyKey[] = ["archivedProperty", "createdProperty", "modifiedProperty"];

function isDateEnabled(settings: ArchiveSettings, key: DatePropertyKey): boolean {
  if (key === "archivedProperty") return settings.addArchivedDate;
  if (key === "createdProperty") return settings.addCreatedDate;
  return settings.addModifiedDate;
}

function repairDuplicateDateProperties(settings: ArchiveSettings): void {
  const used = new Set<string>();
  for (const key of DATE_PROPERTY_KEYS) {
    if (!isDateEnabled(settings, key)) continue;
    const property = settings[key];
    if (used.has(property)) settings[key] = DEFAULT_SETTINGS[key];
    used.add(settings[key]);
  }
}
