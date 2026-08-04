import assert from "node:assert/strict";
import test from "node:test";
import { around } from "monkey-around";
import {
  installDeletionInterceptor,
  type DeleteChoice,
  type DeletionInterceptorOptions,
  type DeletionManager,
} from "../src/delete.ts";
import type { DeleteAction } from "../src/path.ts";

class AbstractFile {
  constructor(readonly path: string) {}
}

class File extends AbstractFile {}
class Folder extends AbstractFile {}

function makeFixture() {
  const calls: string[] = [];
  let action: DeleteAction = "ask";
  let choice: DeleteChoice = "cancel";
  const manager: DeletionManager<AbstractFile> = {
    async promptForDeletion(file) {
      calls.push(`original:${file.path}`);
      return true;
    },
    async trashFile(file) {
      calls.push(`trash:${file.path}`);
    },
  };
  const options: DeletionInterceptorOptions<AbstractFile, File> = {
    async archive(file) {
      calls.push(`archive:${file.path}`);
      return true;
    },
    async choose(file) {
      calls.push(`choose:${file.path}`);
      return choice;
    },
    getAction: () => action,
    isArchived: (file) => file.path.startsWith("Archive/"),
    isFile: (file): file is File => file instanceof File,
  };

  return {
    calls,
    manager,
    options,
    setAction(value: DeleteAction) {
      action = value;
    },
    setChoice(value: DeleteChoice) {
      choice = value;
    },
  };
}

test("passes folders, archived files, and normal-delete mode to Obsidian", async () => {
  const fixture = makeFixture();
  const uninstall = installDeletionInterceptor(fixture.manager, fixture.options);

  await fixture.manager.promptForDeletion(new Folder("Projects"));
  await fixture.manager.promptForDeletion(new File("Archive/note.md"));
  fixture.setAction("delete");
  await fixture.manager.promptForDeletion(new File("Projects/note.md"));

  assert.deepEqual(fixture.calls, [
    "original:Projects",
    "original:Archive/note.md",
    "original:Projects/note.md",
  ]);
  uninstall();
});

test("automatically archives instead of invoking the original deletion", async () => {
  const fixture = makeFixture();
  fixture.setAction("archive");
  const uninstall = installDeletionInterceptor(fixture.manager, fixture.options);

  const confirmed = await fixture.manager.promptForDeletion(new File("Projects/note.md"));

  assert.equal(confirmed, true);
  assert.deepEqual(fixture.calls, ["archive:Projects/note.md"]);
  uninstall();
});

test("handles archive, delete, and cancel choices", async () => {
  const fixture = makeFixture();
  const uninstall = installDeletionInterceptor(fixture.manager, fixture.options);

  fixture.setChoice("archive");
  assert.equal(await fixture.manager.promptForDeletion(new File("one.md")), true);
  fixture.setChoice("delete");
  assert.equal(await fixture.manager.promptForDeletion(new File("two.md")), true);
  fixture.setChoice("cancel");
  assert.equal(await fixture.manager.promptForDeletion(new File("three.md")), false);

  assert.deepEqual(fixture.calls, [
    "choose:one.md",
    "archive:one.md",
    "choose:two.md",
    "trash:two.md",
    "choose:three.md",
  ]);
  uninstall();
});

test("restores the exact original method after uninstall", async () => {
  const fixture = makeFixture();
  const original = fixture.manager.promptForDeletion;
  const uninstall = installDeletionInterceptor(fixture.manager, fixture.options);

  assert.notEqual(fixture.manager.promptForDeletion, original);
  uninstall();

  assert.equal(fixture.manager.promptForDeletion, original);
  await fixture.manager.promptForDeletion(new File("note.md"));
  assert.deepEqual(fixture.calls, ["original:note.md"]);
});

test("remains correct when another wrapper is removed in either order", async () => {
  const fixture = makeFixture();
  const original = fixture.manager.promptForDeletion;
  const uninstallArchive = installDeletionInterceptor(fixture.manager, fixture.options);
  const uninstallOther = around(fixture.manager, {
    promptForDeletion: (next) => async function (this: DeletionManager<AbstractFile>, file: AbstractFile) {
      fixture.calls.push(`other:${file.path}`);
      return next.call(this, file);
    },
  });

  uninstallArchive();
  await fixture.manager.promptForDeletion(new File("first.md"));
  uninstallOther();
  await fixture.manager.promptForDeletion(new File("cleanup.md"));
  assert.equal(fixture.manager.promptForDeletion, original);

  const uninstallOtherFirst = around(fixture.manager, {
    promptForDeletion: (next) => async function (this: DeletionManager<AbstractFile>, file: AbstractFile) {
      fixture.calls.push(`other-first:${file.path}`);
      return next.call(this, file);
    },
  });
  const uninstallArchiveSecond = installDeletionInterceptor(fixture.manager, fixture.options);
  uninstallOtherFirst();
  fixture.setChoice("cancel");
  await fixture.manager.promptForDeletion(new File("second.md"));
  uninstallArchiveSecond();
  await fixture.manager.promptForDeletion(new File("cleanup-two.md"));

  assert.equal(fixture.manager.promptForDeletion, original);
  assert.deepEqual(fixture.calls, [
    "other:first.md",
    "original:first.md",
    "original:cleanup.md",
    "choose:second.md",
    "original:cleanup-two.md",
  ]);
});
