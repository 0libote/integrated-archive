import type { DeleteAction } from "./path";
import { resolveDeleteAction } from "./path";

export type ExistingDateAction = "preserve" | "overwrite";
export type DatePropertyKey = "archivedProperty" | "createdProperty" | "modifiedProperty";
export type PropertySlotKey = DatePropertyKey | "originalPathProperty";

export interface ArchivePropertySnapshot {
  existed: boolean;
  key: string;
  value?: unknown;
}

export interface ArchiveMetadataSnapshot {
  properties: ArchivePropertySnapshot[];
}

export interface ArchiveRecord {
  archivedAt: number;
  archivedPath: string;
  metadata?: ArchiveMetadataSnapshot;
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
  storeOriginalPath: boolean;
  originalPathProperty: string;
  excludedPaths: string;
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
  storeOriginalPath: false,
  originalPathProperty: "archive-original-path",
  excludedPaths: "",
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
  "storeOriginalPath",
] as const;

const STRING_KEYS = [
  "archiveFolder",
  "tag",
  "archivedProperty",
  "createdProperty",
  "modifiedProperty",
  "dateFormat",
  "originalPathProperty",
  "excludedPaths",
] as const;

const PROPERTY_NAME_KEYS = ["archivedProperty", "createdProperty", "modifiedProperty", "originalPathProperty"] as const;

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
  settings.excludedPaths = sanitizeExcludedPaths(settings.excludedPaths);

  repairSettings(settings);

  return settings;
}

function repairSettings(settings: ArchiveSettings): void {
  if (validateArchiveFolder(settings.archiveFolder)) settings.archiveFolder = DEFAULT_SETTINGS.archiveFolder;
  settings.tag = normalizeTag(settings.tag) ?? DEFAULT_SETTINGS.tag;
  for (const key of PROPERTY_NAME_KEYS) {
    if (validatePropertyName(settings[key])) settings[key] = DEFAULT_SETTINGS[key];
  }
  if (validateDateFormat(settings.dateFormat)) settings.dateFormat = DEFAULT_SETTINGS.dateFormat;
  repairPropertyCollisions(settings);
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
  if (!/\D/.test(tag)) return "Tags must contain at least one non-numeric character.";
  return undefined;
}

export function validatePropertyName(value: string): string | undefined {
  const property = value.trim();
  if (!property) return "Enter a property name.";
  if (/[\r\n]/.test(value)) return "Property names must fit on one line.";
  if (RESERVED_PROPERTY_NAMES.has(property)) return "Choose a different property name.";
  return undefined;
}

export function validatePropertySlot(
  settings: ArchiveSettings,
  key: PropertySlotKey,
  value: string,
): string | undefined {
  const invalidName = validatePropertyName(value);
  if (invalidName) return invalidName;

  const candidate = value.trim();
  if (settings.addTag && candidate === "tags") return "Choose a different property name.";
  for (const otherKey of PROPERTY_SLOT_KEYS) {
    if (otherKey !== key && isSlotEnabled(settings, otherKey) && settings[otherKey].trim() === candidate) {
      return "Use a unique name for each enabled property.";
    }
  }
  return undefined;
}

export function validateDateProperty(
  settings: ArchiveSettings,
  key: DatePropertyKey,
  value: string,
): string | undefined {
  return validatePropertySlot(settings, key, value);
}

export function validateDateFormat(value: string): string | undefined {
  const format = value.trim();
  if (!format) return "Enter a date format.";
  if (/[\r\n]/.test(value)) return "Date formats must fit on one line.";
  if (!/[A-Za-z]/.test(format)) return "Include a date token such as YYYY or MM.";
  return undefined;
}

export function parseExcludedPaths(value: string): string[] {
  return value
    .split("\n")
    .map((line) => stripSlashes(line.trim()))
    .filter(Boolean);
}

function stripSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") start++;
  while (end > start && value[end - 1] === "/") end--;
  return value.slice(start, end);
}

export function sanitizeExcludedPaths(value: string): string {
  return parseExcludedPaths(value)
    .filter((path) => !path.split("/").some((part) => part === "." || part === ".."))
    .join("\n");
}

export function validateExcludedPaths(value: string): string | undefined {
  if (/\\/.test(value)) return "Use forward slashes.";
  for (const path of parseExcludedPaths(value)) {
    if (path.split("/").some((part) => part === "." || part === "..")) {
      return "Use relative paths without . or .. segments.";
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
    && !!value.originalPath
    && (value.metadata === undefined || isMetadataSnapshot(value.metadata));
}

export const MAX_ARCHIVE_HISTORY = 200;

const DATE_PROPERTY_KEYS: DatePropertyKey[] = ["archivedProperty", "createdProperty", "modifiedProperty"];
const PROPERTY_SLOT_KEYS: PropertySlotKey[] = [...DATE_PROPERTY_KEYS, "originalPathProperty"];
const RESERVED_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isMetadataSnapshot(value: unknown): value is ArchiveMetadataSnapshot {
  return isRecord(value)
    && Array.isArray(value.properties)
    && value.properties.every((property) => isRecord(property)
      && typeof property.key === "string"
      && !validatePropertyName(property.key)
      && typeof property.existed === "boolean");
}

function isSlotEnabled(settings: ArchiveSettings, key: PropertySlotKey): boolean {
  if (key === "archivedProperty") return settings.addArchivedDate;
  if (key === "createdProperty") return settings.addCreatedDate;
  if (key === "modifiedProperty") return settings.addModifiedDate;
  return settings.storeOriginalPath;
}

function repairPropertyCollisions(settings: ArchiveSettings): void {
  const used = new Set<string>();
  if (settings.addTag) used.add("tags");
  for (const key of PROPERTY_SLOT_KEYS) {
    if (!isSlotEnabled(settings, key)) continue;
    let property = settings[key];
    if (used.has(property)) {
      property = DEFAULT_SETTINGS[key];
      let suffix = 2;
      while (used.has(property)) property = `${DEFAULT_SETTINGS[key]}-${suffix++}`;
      settings[key] = property;
    }
    used.add(property);
  }
}
