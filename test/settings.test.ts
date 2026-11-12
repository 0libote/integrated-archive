import { expect, test } from "bun:test";
import {
  DEFAULT_SETTINGS,
  normalizeTag,
  parseExcludedPaths,
  sanitizeExcludedPaths,
  sanitizeSettings,
  sanitizeData,
  validateArchiveFolder,
  validateDateFormat,
  validateDateProperty,
  validateExcludedOverlap,
  validateExcludedPaths,
  validatePropertyName,
  validatePropertySlot,
  validateTag,
} from "../src/settings.ts";

test("sanitizes missing, malformed, and legacy settings", () => {
  expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);

  const malformed = sanitizeSettings({
    archiveFolder: " ../Archive ",
    preserveFolders: "yes",
    cleanEmptyFolders: "yes",
    tag: "#",
    addTag: false,
    archivedProperty: "__proto__",
    createdProperty: "constructor",
    modifiedProperty: "prototype",
    dateFormat: " ",
    deleteAction: "invalid",
    existingDateAction: "invalid",
  });
  expect(malformed.archiveFolder).toBe("Archive");
  expect(malformed.preserveFolders).toBe(false);
  expect(malformed.cleanEmptyFolders).toBe(false);
  expect(malformed.tag).toBe("archived");
  expect(malformed.addTag).toBe(false);
  expect(malformed.dateFormat).toBe("YYYY-MM-DD");
  expect(malformed.deleteAction).toBe("ask");
  expect(malformed.existingDateAction).toBe("preserve");
  expect(malformed.archivedProperty).toBe("archived");
  expect(malformed.createdProperty).toBe("created");
  expect(malformed.modifiedProperty).toBe("modified");

  expect(sanitizeSettings({ promptOnDelete: false }).deleteAction).toBe("delete");
  expect(sanitizeSettings({ promptOnDelete: true }).deleteAction).toBe("ask");
});

test("sanitizes archive history records", () => {
  const data = sanitizeData({
    archiveHistory: [
      {
        archivedAt: 100,
        archivedPath: "Archive/note.md",
        metadata: { properties: [{ existed: true, key: "tags", value: ["active"] }] },
        originalPath: "note.md",
      },
      { archivedAt: "invalid", archivedPath: "Archive/bad.md", originalPath: "bad.md" },
      {
        archivedAt: 200,
        archivedPath: "Archive/unsafe.md",
        metadata: { properties: [{ existed: false, key: "__proto__" }] },
        originalPath: "unsafe.md",
      },
      null,
    ],
  });

  expect(data.archiveHistory).toEqual([
    {
      archivedAt: 100,
      archivedPath: "Archive/note.md",
      metadata: { properties: [{ existed: true, key: "tags", value: ["active"] }] },
      originalPath: "note.md",
    },
  ]);
});

test("preserves attachment group ids in archive history", () => {
  const data = sanitizeData({
    archiveHistory: [
      { archivedAt: 100, archivedPath: "Archive/note.md", groupId: "300:note.md", originalPath: "note.md" },
      { archivedAt: 100, archivedPath: "Archive/image.png", groupId: "300:note.md", originalPath: "image.png" },
      { archivedAt: 100, archivedPath: "Archive/bad.md", groupId: 42, originalPath: "bad.md" },
    ],
  });

  expect(data.archiveHistory).toEqual([
    { archivedAt: 100, archivedPath: "Archive/note.md", groupId: "300:note.md", originalPath: "note.md" },
    { archivedAt: 100, archivedPath: "Archive/image.png", groupId: "300:note.md", originalPath: "image.png" },
  ]);
});

test("keeps valid settings and normalizes a leading tag marker", () => {
  const settings = sanitizeSettings({
    archiveFolder: "Storage/Archive",
    preserveFolders: true,
    cleanEmptyFolders: true,
    archiveAttachments: true,
    includeSharedAttachments: true,
    deleteAction: "archive",
    tag: "#project/archive",
    existingDateAction: "overwrite",
  });

  expect(settings.archiveFolder).toBe("Storage/Archive");
  expect(settings.preserveFolders).toBe(true);
  expect(settings.cleanEmptyFolders).toBe(true);
  expect(settings.archiveAttachments).toBe(true);
  expect(settings.includeSharedAttachments).toBe(true);
  expect(settings.deleteAction).toBe("archive");
  expect(settings.tag).toBe("project/archive");
  expect(settings.existingDateAction).toBe("overwrite");
});

test("repairs duplicate enabled date properties loaded from disk", () => {
  const settings = sanitizeSettings({
    archivedProperty: "date",
    createdProperty: "date",
    modifiedProperty: "date",
  });

  expect(settings.archivedProperty).toBe("date");
  expect(settings.createdProperty).toBe("created");
  expect(settings.modifiedProperty).toBe("modified");
});

test("resolves collisions with default property names", () => {
  const settings = sanitizeSettings({
    archivedProperty: "created",
    createdProperty: "created",
  });

  expect(settings.archivedProperty).toBe("created");
  expect(settings.createdProperty).not.toBe(settings.archivedProperty);
});

test("keeps every enabled property name distinct including the stored path", () => {
  const settings = sanitizeSettings({
    archivedProperty: "modified",
    createdProperty: "modified",
    modifiedProperty: "modified",
    storeOriginalPath: true,
    originalPathProperty: "modified",
  });

  const names = [settings.archivedProperty, settings.createdProperty, settings.modifiedProperty, settings.originalPathProperty];
  expect(new Set(names).size).toBe(names.length);
});

test("repairs a date property that collides with the tag property", () => {
  const settings = sanitizeSettings({ archivedProperty: "tags" });

  expect(settings.archivedProperty).not.toBe("tags");
});

test("validates archive folders", () => {
  expect(validateArchiveFolder("Archive")).toBe(undefined);
  expect(validateArchiveFolder("Storage/Archive")).toBe(undefined);
  expect(validateArchiveFolder("" ) ?? "").toMatch(/Enter/);
  expect(validateArchiveFolder("../Archive") ?? "").toMatch(/\.\./);
  expect(validateArchiveFolder("/Archive") ?? "").toMatch(/relative/);
  expect(validateArchiveFolder("Storage\\Archive") ?? "").toMatch(/forward slashes/);
});

test("validates and normalizes archive tags", () => {
  expect(validateTag("archived")).toBe(undefined);
  expect(validateTag("project/archive")).toBe(undefined);
  expect(normalizeTag(" #archived ")).toBe("archived");
  expect(normalizeTag("#")).toBe(null);
  expect(validateTag("two words") ?? "").toMatch(/spaces/);
  expect(validateTag("123") ?? "").toMatch(/non-numeric/);
});

test("validates property names and prevents enabled date collisions", () => {
  const settings = { ...DEFAULT_SETTINGS };
  expect(validatePropertyName("created-at")).toBe(undefined);
  expect(validatePropertyName(" ") ?? "").toMatch(/Enter/);
  expect(validatePropertyName("bad\nname") ?? "").toMatch(/one line/);
  expect(validatePropertyName("__proto__") ?? "").toMatch(/different/);
  expect(validatePropertyName("constructor") ?? "").toMatch(/different/);
  expect(validatePropertyName("prototype") ?? "").toMatch(/different/);
  expect(validateDateProperty(settings, "createdProperty", "created-at")).toBe(undefined);
  expect(validateDateProperty(settings, "createdProperty", "archived") ?? "").toMatch(/unique/);

  settings.addArchivedDate = false;
  expect(validateDateProperty(settings, "createdProperty", "archived")).toBe(undefined);
});

test("rejects property names that collide with the tag property or stored path", () => {
  const settings = { ...DEFAULT_SETTINGS, addTag: true, addArchivedDate: false };
  expect(validatePropertySlot(settings, "createdProperty", "tags") ?? "").toMatch(/different/);

  settings.storeOriginalPath = true;
  expect(validatePropertySlot(settings, "createdProperty", "created")).toBe(undefined);
  expect(validatePropertySlot(settings, "createdProperty", "archive-original-path") ?? "").toMatch(/unique/);
});

test("validates date formats", () => {
  expect(validateDateFormat("YYYY-MM-DD")).toBe(undefined);
  expect(validateDateFormat("[Archived] YYYY")).toBe(undefined);
  expect(validateDateFormat("  ") ?? "").toMatch(/Enter/);
  expect(validateDateFormat("---") ?? "").toMatch(/token/);
  expect(validateDateFormat("YYYY\nMM") ?? "").toMatch(/one line/);
});

test("parses, sanitizes, and validates protected paths", () => {
  expect(parseExcludedPaths(" Private \n/Templates/\n\n")).toEqual(["Private", "Templates"]);
  expect(parseExcludedPaths("")).toEqual([]);
  expect(parseExcludedPaths("Private//Templates")).toEqual(["Private/Templates"]);
  expect(sanitizeExcludedPaths("Private\n../Secret\nTemplates")).toBe("Private\nTemplates");
  expect(sanitizeExcludedPaths("Private\r\nTemplates")).toBe("Private\nTemplates");
  expect(validateExcludedPaths("Private\nTemplates")).toBe(undefined);
  expect(validateExcludedPaths("../Secret") ?? "").toMatch(/segments/);
  expect(validateExcludedPaths("a\\b") ?? "").toMatch(/forward slashes/);
});

test("rejects protected paths overlapping the archive folder", () => {
  expect(validateExcludedOverlap("Archive", "Private\nTemplates")).toBe(undefined);
  expect(validateExcludedOverlap("Archive", "Archive") ?? "").toMatch(/overlap/i);
  expect(validateExcludedOverlap("Archive", "Archive/Projects") ?? "").toMatch(/overlap/i);
  expect(validateExcludedOverlap("Storage/Archive", "Storage") ?? "").toMatch(/overlap/i);
  expect(validateExcludedOverlap(".", "Archive")).toBe(undefined);
});

test("keeps protected paths and resets an overlapping archive folder", () => {
  // A bad sync must never silently unprotect user data: protection wins.
  const settings = sanitizeSettings({ archiveFolder: "Private/Archive", excludedPaths: "Private" });
  expect(settings.excludedPaths).toBe("Private");
  expect(settings.archiveFolder).toBe("Archive");
});

test("loads and normalizes protected paths from stored settings", () => {
  const settings = sanitizeSettings({ excludedPaths: " Private \r\n\r\n Templates " });

  expect(settings.excludedPaths).toBe("Private\nTemplates");
  expect(sanitizeSettings({}).excludedPaths).toBe("");
});
