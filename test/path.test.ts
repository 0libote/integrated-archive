import { expect, test } from "bun:test";
import { addCollisionSuffix, isPathInFolder, parentFolder, resolveDeleteAction } from "../src/path.ts";

test("adds collision numbers before the extension", () => {
  expect(addCollisionSuffix("Archive/note.md", 0)).toBe("Archive/note.md");
  expect(addCollisionSuffix("Archive/note.md", 2)).toBe("Archive/note (2).md");
  expect(addCollisionSuffix("Archive/folder.name/note", 1)).toBe("Archive/folder.name/note (1)");
});

test("treats leading-dot files as extensionless", () => {
  expect(addCollisionSuffix("Archive/.gitignore", 1)).toBe("Archive/.gitignore (1)");
  expect(addCollisionSuffix(".env", 1)).toBe(".env (1)");
});

test("only matches files inside the configured archive", () => {
  expect(isPathInFolder("Archive/note.md", "Archive")).toBe(true);
  expect(isPathInFolder("Archive 2/note.md", "Archive")).toBe(false);
});

test("migrates the old delete prompt setting", () => {
  expect(resolveDeleteAction(undefined, true)).toBe("ask");
  expect(resolveDeleteAction(undefined, false)).toBe("delete");
  expect(resolveDeleteAction("archive")).toBe("archive");
});

test("returns the parent folder without mangling root-level files", () => {
  expect(parentFolder("note.md")).toBe("");
  expect(parentFolder("Projects/note.md")).toBe("Projects");
  expect(parentFolder("Projects/Work/note.md")).toBe("Projects/Work");
});
