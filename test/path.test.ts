import assert from "node:assert/strict";
import test from "node:test";
import { addCollisionSuffix, isPathInFolder, resolveDeleteAction } from "../src/path.ts";

test("adds collision numbers before the extension", () => {
  assert.equal(addCollisionSuffix("Archive/note.md", 0), "Archive/note.md");
  assert.equal(addCollisionSuffix("Archive/note.md", 2), "Archive/note (2).md");
  assert.equal(addCollisionSuffix("Archive/folder.name/note", 1), "Archive/folder.name/note (1)");
});

test("treats leading-dot files as extensionless", () => {
  assert.equal(addCollisionSuffix("Archive/.gitignore", 1), "Archive/.gitignore (1)");
  assert.equal(addCollisionSuffix(".env", 1), ".env (1)");
});

test("only matches files inside the configured archive", () => {
  assert.equal(isPathInFolder("Archive/note.md", "Archive"), true);
  assert.equal(isPathInFolder("Archive 2/note.md", "Archive"), false);
});

test("migrates the old delete prompt setting", () => {
  assert.equal(resolveDeleteAction(undefined, true), "ask");
  assert.equal(resolveDeleteAction(undefined, false), "delete");
  assert.equal(resolveDeleteAction("archive"), "archive");
});
