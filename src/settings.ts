import type { DeleteAction } from "./path";
import { isPathInFolder, resolveDeleteAction } from "./path";

export type ExistingDateAction = "preserve" | "overwrite";
export type DatePropertyKey = "archivedProperty" | "createdProperty" | "modifiedProperty";
export type PropertySlotKey = DatePropertyKey | "originalPathProperty";

export interface ArchivePropertySnapshot {
  existed: boolean;
  key: string;
  value?: unknown;
  archivedValue?: unknown;
}

export interface ArchiveMetadataSnapshot {
  properties: ArchivePropertySnapshot[];
}

export interface ArchiveRecord {
  archivedAt: number;
  archivedPath: string;
  groupId?: string;
  metadata?: ArchiveMetadataSnapshot;
  originalPath: string;
}

export interface FolderDestination {
  destination: string;
  source: string;
}

export interface ArchiveSettings {
  archiveFolder: string;
  folderDestinations: string;
  preserveFolders: boolean;
  cleanEmptyFolders: boolean;
  archiveAttachments: boolean;
  includeSharedAttachments: boolean;
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
  showRibbonIcon: boolean;
  staleArchiving: boolean;
  staleDays: number;
  staleFolders: string;
}

export interface ArchiveData extends ArchiveSettings {
  archiveHistory: ArchiveRecord[];
}

export const DEFAULT_SETTINGS: ArchiveSettings = {
  archiveFolder: "Archive",
  folderDestinations: "",
  preserveFolders: false,
  cleanEmptyFolders: false,
  archiveAttachments: false,
  includeSharedAttachments: false,
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
  showRibbonIcon: true,
  staleArchiving: false,
  staleDays: 90,
  staleFolders: "",
};

export const DEFAULT_DATA: ArchiveData = {
  ...DEFAULT_SETTINGS,
  archiveHistory: [],
};

const BOOLEAN_KEYS = [
  "preserveFolders",
  "cleanEmptyFolders",
  "archiveAttachments",
  "includeSharedAttachments",
  "showArchiveMenu",
  "showRibbonIcon",
  "addTag",
  "addArchivedDate",
  "addCreatedDate",
  "addModifiedDate",
  "storeOriginalPath",
  "staleArchiving",
] as const;

const STRING_KEYS = [
  "archiveFolder",
  "folderDestinations",
  "tag",
  "archivedProperty",
  "createdProperty",
  "modifiedProperty",
  "dateFormat",
  "originalPathProperty",
  "excludedPaths",
  "staleFolders",
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
  // A day count of zero or garbage would archive everything on the next scan,
  // so only a positive whole number is accepted; anything else stays default.
  const staleDays = stored.staleDays;
  settings.staleDays = typeof staleDays === "number" && Number.isInteger(staleDays) && staleDays >= 1
    ? staleDays
    : DEFAULT_SETTINGS.staleDays;
  settings.archiveFolder = normalizeExcludedSegment(settings.archiveFolder);
  settings.excludedPaths = sanitizeExcludedPaths(settings.excludedPaths);
  settings.staleFolders = sanitizeExcludedPaths(settings.staleFolders);
  settings.folderDestinations = canonicalizeFolderDestinations(settings.folderDestinations);

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
  // Self-heal overlapping protected paths on load: the settings UI blocks new
  // overlaps, but synced data.json may predate the check. Protection wins over
  // location, so a bad sync moves the archive folder back instead of silently
  // unprotecting user data. Only when even the default folder overlaps do the
  // overlapping lines get dropped so archiving can run at all.
  if (overlapsArchiveFolder(settings.archiveFolder, settings.excludedPaths)) {
    settings.archiveFolder = DEFAULT_SETTINGS.archiveFolder;
    if (overlapsArchiveFolder(settings.archiveFolder, settings.excludedPaths)) {
      const folder = normalizeExcludedSegment(settings.archiveFolder);
      settings.excludedPaths = parseExcludedPaths(settings.excludedPaths)
        .filter((excluded) =>
          excluded !== folder && !isPathInFolder(excluded, folder) && !isPathInFolder(folder, excluded))
        .join("\n");
    }
  }
  // Protection wins over routing too: a destination that overlaps a protected
  // path could never receive archives, so the rule is dropped instead of
  // failing every archive from that source.
  settings.folderDestinations = sanitizeFolderDestinations(settings.folderDestinations, settings.excludedPaths);
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
  const folder = normalizeExcludedSegment(value);
  if (!folder || folder === ".") return "Enter an archive folder.";
  if (value.trim().startsWith("/") || value.includes("\\")) return "Use a path relative to the vault root with forward slashes.";
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

function normalizeExcludedSegment(value: string): string {
  return stripSlashes(value.trim()).replace(/\/{2,}/g, "/");
}

export function parsePathList(value: string): string[] {
  return value
    .split("\n")
    .map((line) => normalizeExcludedSegment(line))
    .filter(Boolean);
}

export function parseExcludedPaths(value: string): string[] {
  return parsePathList(value);
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

function overlapsArchiveFolder(archiveFolder: string, value: string): boolean {
  const folder = normalizeExcludedSegment(archiveFolder);
  if (!folder || folder === ".") return false;
  return parseExcludedPaths(value).some((excluded) =>
    excluded === folder || isPathInFolder(excluded, folder) || isPathInFolder(folder, excluded));
}

export function validateExcludedOverlap(archiveFolder: string, value: string): string | undefined {
  const folder = normalizeExcludedSegment(archiveFolder);
  if (!folder || folder === ".") return undefined;
  for (const excluded of parseExcludedPaths(value)) {
    if (excluded === folder) return "Protected paths overlap the archive folder.";
    const protectedInsideArchive = isPathInFolder(excluded, folder);
    const archiveInsideProtected = isPathInFolder(folder, excluded);
    if (protectedInsideArchive || archiveInsideProtected) {
      return "Protected paths overlap the archive folder.";
    }
  }
  return undefined;
}

export function parseFolderDestinations(value: string): FolderDestination[] {
  const rules: FolderDestination[] = [];
  for (const line of value.split("\n")) {
    const separator = line.indexOf("=>");
    if (separator < 0) continue;
    const source = normalizeExcludedSegment(line.slice(0, separator));
    const destination = normalizeExcludedSegment(line.slice(separator + 2));
    if (!source || !destination || line.includes("\\")) continue;
    if (hasDotSegment(source) || hasDotSegment(destination)) continue;
    rules.push({ destination, source });
  }
  return rules;
}

function hasDotSegment(path: string): boolean {
  return path.split("/").some((part) => part === "." || part === "..");
}

function canonicalizeFolderDestinations(value: string): string {
  return parseFolderDestinations(value)
    .map((rule) => `${rule.source} => ${rule.destination}`)
    .join("\n");
}

export function sanitizeFolderDestinations(value: string, excludedPaths: string): string {
  return parseFolderDestinations(value)
    .filter((rule) => !validateArchiveFolder(rule.destination) && !validateExcludedOverlap(rule.destination, excludedPaths))
    .map((rule) => `${rule.source} => ${rule.destination}`)
    .join("\n");
}

export function validateFolderDestinations(value: string, settings: ArchiveSettings): string | undefined {
  for (const line of value.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf("=>");
    if (separator < 0) return "Use one Source => Destination rule per line.";
    const source = line.slice(0, separator).trim();
    const destination = line.slice(separator + 2).trim();
    if (!source || !destination) return "Use one Source => Destination rule per line.";
    if (line.includes("\\")) return "Use forward slashes.";
    if (source.split("/").some((part) => !part || part === "." || part === "..")) {
      return "Use source paths without empty, . or .. segments.";
    }
    const invalidDestination = validateArchiveFolder(destination);
    if (invalidDestination) return invalidDestination;
  }
  for (const rule of parseFolderDestinations(value)) {
    if (validateExcludedOverlap(rule.destination, settings.excludedPaths)) {
      return "Destinations overlap protected paths.";
    }
  }
  return undefined;
}

export function validateStaleDays(value: string): string | undefined {
  if (!/^\d+$/.test(value.trim()) || Number(value.trim()) < 1) {
    return "Enter a whole number of days (1 or more).";
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
    && (value.groupId === undefined || typeof value.groupId === "string")
    && typeof value.originalPath === "string"
    && !!value.originalPath
    && (value.metadata === undefined || isMetadataSnapshot(value.metadata));
}

export const MAX_ARCHIVE_HISTORY = 200;

const PROPERTY_SLOT_KEYS: PropertySlotKey[] = ["archivedProperty", "createdProperty", "modifiedProperty", "originalPathProperty"];
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
