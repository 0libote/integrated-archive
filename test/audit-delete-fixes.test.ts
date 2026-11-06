import { expect, test } from "bun:test";
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

function makeFixture() {
  const calls: string[] = [];
  let action: DeleteAction = "ask";
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
    async choose(): Promise<DeleteChoice> {
      return "cancel";
    },
    getAction: () => action,
    isArchived: (file) => file.path.startsWith("Archive/"),
    isFile: (file): file is File => file instanceof File,
  };
  return {
    calls, manager, options,
    setAction(value: DeleteAction) {
      action = value;
    },
  };
}

test("coalesces concurrent archives for distinct instances of the same path", async () => {
  const fixture = makeFixture();
  fixture.setAction("archive");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let archives = 0;
  fixture.options.archive = async (file) => {
    archives++;
    fixture.calls.push(`archive:${file.path}`);
    await gate;
    return true;
  };
  const uninstall = installDeletionInterceptor(fixture.manager, fixture.options);
  const first = fixture.manager.trashFile(new File("same.md"));
  const second = fixture.manager.trashFile(new File("same.md"));
  await Promise.resolve();
  release();
  await Promise.all([first, second]);
  expect(archives).toBe(1);
  expect(fixture.calls.filter((call) => call === "archive:same.md").length).toBe(1);
  uninstall();
});

test("failed archive in automatic mode falls back to normal delete", async () => {
  const fixture = makeFixture();
  fixture.setAction("archive");
  fixture.options.archive = async (file) => {
    fixture.calls.push(`archive:${file.path}`);
    return false;
  };
  const uninstall = installDeletionInterceptor(fixture.manager, fixture.options);
  const confirmed = await fixture.manager.promptForDeletion(new File("note.md"));
  expect(confirmed).toBe(true);
  expect(fixture.calls).toEqual(["archive:note.md", "original:note.md"]);
  uninstall();
});

test("failed direct trash in automatic mode falls through to trash", async () => {
  const fixture = makeFixture();
  fixture.setAction("archive");
  fixture.options.archive = async (file) => {
    fixture.calls.push(`archive:${file.path}`);
    return false;
  };
  const uninstall = installDeletionInterceptor(fixture.manager, fixture.options);
  await fixture.manager.trashFile(new File("note.md"));
  expect(fixture.calls).toEqual(["archive:note.md", "trash:note.md"]);
  uninstall();
});

test("explicit delete choice with distinct instances trashes once", async () => {
  const fixture = makeFixture();
  fixture.options.choose = async (): Promise<DeleteChoice> => "delete";
  const uninstall = installDeletionInterceptor(fixture.manager, fixture.options);
  const file = new File("two.md");
  if (await fixture.manager.promptForDeletion(file)) {
    await fixture.manager.trashFile(new File("two.md"));
  }
  expect(fixture.calls.filter((call) => call === "trash:two.md").length).toBe(1);
  uninstall();
});
