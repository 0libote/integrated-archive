import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  normalizeTag,
  sanitizeSettings,
  sanitizeData,
  validateArchiveFolder,
  validateDateFormat,
  validateDateProperty,
  validatePropertyName,
  validatePropertySlot,
  validateTag,
} from "../src/settings.ts";

test("sanitizes missing, malformed, and legacy settings", () => {
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);

  const malformed = sanitizeSettings({
    archiveFolder: " ../Archive ",
    preserveFolders: "yes",
    tag: "#",
    addTag: false,
    archivedProperty: "__proto__",
    createdProperty: "constructor",
    modifiedProperty: "prototype",
    dateFormat: " ",
    deleteAction: "invalid",
    existingDateAction: "invalid",
  });
  assert.equal(malformed.archiveFolder, "Archive");
  assert.equal(malformed.preserveFolders, false);
  assert.equal(malformed.tag, "archived");
  assert.equal(malformed.addTag, false);
  assert.equal(malformed.dateFormat, "YYYY-MM-DD");
  assert.equal(malformed.deleteAction, "ask");
  assert.equal(malformed.existingDateAction, "preserve");
  assert.equal(malformed.archivedProperty, "archived");
  assert.equal(malformed.createdProperty, "created");
  assert.equal(malformed.modifiedProperty, "modified");

  assert.equal(sanitizeSettings({ promptOnDelete: false }).deleteAction, "delete");
  assert.equal(sanitizeSettings({ promptOnDelete: true }).deleteAction, "ask");
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

  assert.deepEqual(data.archiveHistory, [
    {
      archivedAt: 100,
      archivedPath: "Archive/note.md",
      metadata: { properties: [{ existed: true, key: "tags", value: ["active"] }] },
      originalPath: "note.md",
    },
  ]);
});

test("keeps valid settings and normalizes a leading tag marker", () => {
  const settings = sanitizeSettings({
    archiveFolder: "Storage/Archive",
    preserveFolders: true,
    deleteAction: "archive",
    tag: "#project/archive",
    existingDateAction: "overwrite",
  });

  assert.equal(settings.archiveFolder, "Storage/Archive");
  assert.equal(settings.preserveFolders, true);
  assert.equal(settings.deleteAction, "archive");
  assert.equal(settings.tag, "project/archive");
  assert.equal(settings.existingDateAction, "overwrite");
});

test("repairs duplicate enabled date properties loaded from disk", () => {
  const settings = sanitizeSettings({
    archivedProperty: "date",
    createdProperty: "date",
    modifiedProperty: "date",
  });

  assert.equal(settings.archivedProperty, "date");
  assert.equal(settings.createdProperty, "created");
  assert.equal(settings.modifiedProperty, "modified");
});

test("resolves collisions with default property names", () => {
  const settings = sanitizeSettings({
    archivedProperty: "created",
    createdProperty: "created",
  });

  assert.equal(settings.archivedProperty, "created");
  assert.notEqual(settings.createdProperty, settings.archivedProperty);
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
  assert.equal(new Set(names).size, names.length);
});

test("repairs a date property that collides with the tag property", () => {
  const settings = sanitizeSettings({ archivedProperty: "tags" });

  assert.notEqual(settings.archivedProperty, "tags");
});

test("validates archive folders", () => {
  assert.equal(validateArchiveFolder("Archive"), undefined);
  assert.equal(validateArchiveFolder("Storage/Archive"), undefined);
  assert.match(validateArchiveFolder("" ) ?? "", /Enter/);
  assert.match(validateArchiveFolder("../Archive") ?? "", /\.\./);
  assert.match(validateArchiveFolder("/Archive") ?? "", /relative/);
  assert.match(validateArchiveFolder("Storage\\Archive") ?? "", /forward slashes/);
});

test("validates and normalizes archive tags", () => {
  assert.equal(validateTag("archived"), undefined);
  assert.equal(validateTag("project/archive"), undefined);
  assert.equal(normalizeTag(" #archived "), "archived");
  assert.equal(normalizeTag("#"), null);
  assert.match(validateTag("two words") ?? "", /spaces/);
  assert.match(validateTag("123") ?? "", /non-numeric/);
});

test("validates property names and prevents enabled date collisions", () => {
  const settings = { ...DEFAULT_SETTINGS };
  assert.equal(validatePropertyName("created-at"), undefined);
  assert.match(validatePropertyName(" ") ?? "", /Enter/);
  assert.match(validatePropertyName("bad\nname") ?? "", /one line/);
  assert.match(validatePropertyName("__proto__") ?? "", /different/);
  assert.match(validatePropertyName("constructor") ?? "", /different/);
  assert.match(validatePropertyName("prototype") ?? "", /different/);
  assert.equal(validateDateProperty(settings, "createdProperty", "created-at"), undefined);
  assert.match(validateDateProperty(settings, "createdProperty", "archived") ?? "", /unique/);

  settings.addArchivedDate = false;
  assert.equal(validateDateProperty(settings, "createdProperty", "archived"), undefined);
});

test("rejects property names that collide with the tag property or stored path", () => {
  const settings = { ...DEFAULT_SETTINGS, addTag: true, addArchivedDate: false };
  assert.match(validatePropertySlot(settings, "createdProperty", "tags") ?? "", /different/);

  settings.storeOriginalPath = true;
  assert.equal(validatePropertySlot(settings, "createdProperty", "created"), undefined);
  assert.match(validatePropertySlot(settings, "createdProperty", "archive-original-path") ?? "", /unique/);
});

test("validates date formats", () => {
  assert.equal(validateDateFormat("YYYY-MM-DD"), undefined);
  assert.equal(validateDateFormat("[Archived] YYYY"), undefined);
  assert.match(validateDateFormat("  ") ?? "", /Enter/);
  assert.match(validateDateFormat("---") ?? "", /token/);
  assert.match(validateDateFormat("YYYY\nMM") ?? "", /one line/);
});
