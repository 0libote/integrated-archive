import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  normalizeTag,
  sanitizeSettings,
  validateArchiveFolder,
  validateDateProperty,
  validatePropertyName,
  validateTag,
} from "../src/settings.ts";

test("sanitizes missing, malformed, and legacy settings", () => {
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);

  const malformed = sanitizeSettings({
    archiveFolder: " ../Archive ",
    preserveFolders: "yes",
    tag: "#",
    addTag: false,
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

  assert.equal(sanitizeSettings({ promptOnDelete: false }).deleteAction, "delete");
  assert.equal(sanitizeSettings({ promptOnDelete: true }).deleteAction, "ask");
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
  assert.equal(validateDateProperty(settings, "createdProperty", "created-at"), undefined);
  assert.match(validateDateProperty(settings, "createdProperty", "archived") ?? "", /unique/);

  settings.addArchivedDate = false;
  assert.equal(validateDateProperty(settings, "createdProperty", "archived"), undefined);
});
