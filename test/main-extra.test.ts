import { expect, test } from "bun:test";
import { afterEach, beforeEach, mock } from "bun:test";
import type { App, PluginManifest } from "obsidian";

type Cleanup = () => void;
type EventCallback = (...args: unknown[]) => unknown;

interface MockCommand {
  id: string;
  [key: string]: unknown;
}

const notices: string[] = [];
const modalButtons: MockButton[] = [];
const modals: MockModal[] = [];

function clickModalButton(text: string): void {
  modalButtons.find((button) => button.text === text)?.click();
}

class MockAbstractFile {
  parent: MockFolder | null = null;
  constructor(public path: string, public name: string) {}
}

class MockFolder extends MockAbstractFile {
  children: MockAbstractFile[] = [];
}

class MockFile extends MockAbstractFile {
  extension: string;
  frontmatter: Record<string, unknown> = {};
  stat = { ctime: 100, mtime: 200 };

  constructor(path: string) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    super(path, name);
    const dot = name.lastIndexOf(".");
    this.extension = dot >= 0 ? name.slice(dot + 1) : "";
  }
}

class MockPlugin {
  app: TestApp;
  cleanups: Cleanup[] = [];
  commands: MockCommand[] = [];
  settingTabs: unknown[] = [];

  constructor(app: TestApp) {
    this.app = app;
  }

  addCommand(command: MockCommand) {
    this.commands.push(command);
    return command;
  }

  addSettingTab(tab: unknown) {
    this.settingTabs.push(tab);
  }

  async loadData() {
    return this.app.loadedData;
  }

  register(cleanup: Cleanup) {
    this.cleanups.push(cleanup);
    return cleanup;
  }

  registerEvent(event: { cleanup?: Cleanup }) {
    if (event.cleanup) this.cleanups.push(event.cleanup);
    return event;
  }

  async saveData(data: unknown) {
    this.app.savedData = structuredClone(data);
  }
}

class MockPluginSettingTab {
  constructor(public app: TestApp, public plugin: MockPlugin) {}
  refreshDomState() {}
  update() {}
  async setControlValue(key: string, value: unknown) {
    (this.plugin as unknown as { settings: Record<string, unknown> }).settings[key] = value;
    await this.plugin.saveData((this.plugin as unknown as { settings: unknown }).settings);
  }
}

class MockModal {
  contentEl = {
    createEl: () => undefined,
    empty: () => undefined,
  };
  constructor(public app: TestApp) {
    modals.push(this);
  }
  close() {
    (this as unknown as { onClose?: () => void }).onClose?.();
  }
  open() {
    (this as unknown as { onOpen?: () => void }).onOpen?.();
  }
  setTitle() {}
}

class MockSetting {
  addButton(callback: (button: MockButton) => void) {
    const button = new MockButton();
    callback(button);
    modalButtons.push(button);
    return this;
  }
}

class MockButton {
  text = "";
  private callback: () => void = () => undefined;

  click() {
    this.callback();
  }

  onClick(callback: () => void) { this.callback = callback; return this; }
  setButtonText(text: string) { this.text = text; return this; }
  setCta() { return this; }
  setDestructive() { return this; }
}

mock.module("obsidian", () => ({
  App: class {},
  Modal: MockModal,
  Notice: class {
    constructor(message: string) {
      notices.push(message);
    }
  },
  Plugin: MockPlugin,
  PluginSettingTab: MockPluginSettingTab,
  Setting: MockSetting,
  SettingDefinitionItem: class {},
  TAbstractFile: MockAbstractFile,
  TFile: MockFile,
  TFolder: MockFolder,
  getLinkpath: (link: string) => link.split("#")[0],
  moment: (timestamp: number) => ({ format: (pattern: string) => `${pattern}:${timestamp}` }),
  normalizePath: (path: string) => path.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/"),
}));

const { default: IntegratedArchivePlugin } = await import("../src/main.ts");

interface TestApp {
  fileManager: {
    processFrontMatter(file: MockFile, update: (frontmatter: Record<string, unknown>) => void): Promise<void>;
    promptForDeletion(file: MockAbstractFile): Promise<boolean>;
    renameFile(file: MockFile, destination: string): Promise<void>;
    trashFile(file: MockAbstractFile): Promise<void>;
  };
  loadedData: unknown;
  metadataCache: {
    getFileCache(file: MockFile): { frontmatter: Record<string, unknown>; links?: Array<{ link: string }>; embeds?: Array<{ link: string }> } | null;
    getFirstLinkpathDest(linkpath: string, sourcePath: string): MockFile | null;
    resolvedLinks: Record<string, Record<number | string, number>>;
  };
  savedData: unknown;
  vault: {
    createFolder(path: string): Promise<void>;
    getAbstractFileByPath(path: string): MockAbstractFile | null;
    getMarkdownFiles(): MockFile[];
    on(name: string, callback: EventCallback): { cleanup: Cleanup };
  };
  workspace: {
    getActiveFile(): MockFile | null;
    layoutReady: boolean;
    on(name: string, callback: EventCallback): { cleanup: Cleanup };
    onLayoutReady(callback: () => void): void;
  };
}

function makeApp() {
  const entries = new Map<string, MockAbstractFile>();
  const events = new Map<string, EventCallback>();
  const folders = new Set<string>();
  const trashed: string[] = [];
  let activeFile: MockFile | null = null;
  let layoutReady = true;
  const layoutReadyCallbacks: Array<() => void> = [];
  const app: TestApp = {
    loadedData: null,
    savedData: null,
    metadataCache: {
      getFileCache: (file) => ({ frontmatter: file.frontmatter }),
      getFirstLinkpathDest: () => null,
      resolvedLinks: {},
    },
    fileManager: {
      async processFrontMatter(file, update) {
        update(file.frontmatter);
      },
      async promptForDeletion(file) {
        trashed.push(`original:${file.path}`);
        return true;
      },
      async renameFile(file, destination) {
        entries.delete(file.path);
        if (file.parent) {
          file.parent.children = file.parent.children.filter((child) => child !== file);
        }
        file.path = destination;
        file.name = destination.slice(destination.lastIndexOf("/") + 1);
        entries.set(destination, file);
      },
      async trashFile(file) {
        trashed.push(file.path);
        entries.delete(file.path);
        if (file.parent) {
          file.parent.children = file.parent.children.filter((child) => child !== file);
        }
      },
    },
    vault: {
      async createFolder(path) {
        folders.add(path);
        entries.set(path, new MockAbstractFile(path, path.slice(path.lastIndexOf("/") + 1)));
      },
      getAbstractFileByPath: (path) => entries.get(path) ?? null,
      getMarkdownFiles: () => [...entries.values()].filter((entry): entry is MockFile => entry instanceof MockFile && entry.extension === "md"),
      on(name, callback) {
        events.set(`vault:${name}`, callback);
        return { cleanup: () => events.delete(`vault:${name}`) };
      },
    },
    workspace: {
      getActiveFile: () => activeFile,
      get layoutReady() {
        return layoutReady;
      },
      on(name, callback) {
        events.set(`workspace:${name}`, callback);
        return { cleanup: () => events.delete(`workspace:${name}`) };
      },
      onLayoutReady(callback) {
        if (layoutReady) callback();
        else layoutReadyCallbacks.push(callback);
      },
    },
  };

  return {
    app,
    entries,
    events,
    folders,
    setActive(file: MockFile | null) {
      activeFile = file;
      if (file) entries.set(file.path, file);
    },
    setLayoutReady(ready: boolean) {
      layoutReady = ready;
      if (ready) {
        const pending = layoutReadyCallbacks.splice(0);
        for (const callback of pending) callback();
      }
    },
    trashed,
  };
}

let plugin: InstanceType<typeof IntegratedArchivePlugin> | undefined;

beforeEach(() => {
  notices.length = 0;
  modalButtons.length = 0;
  modals.length = 0;
  mock.restore();
});

afterEach(() => {
  if (plugin) {
    for (const cleanup of (plugin as unknown as MockPlugin).cleanups.reverse()) cleanup();
    plugin = undefined;
  }
});

test("bulk confirm cancel leaves the vault untouched", async () => {
  const fixture = makeApp();
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  const files: MockFile[] = [];
  for (let i = 0; i < 11; i++) {
    const file = new MockFile(`note${i}.md`);
    fixture.entries.set(file.path, file);
    files.push(file);
  }
  const pending = (plugin as unknown as { archiveMany(files: MockFile[]): Promise<void> }).archiveMany(files);
  await Bun.sleep(10);
  expect(modalButtons.some((b) => b.text === "Continue")).toBe(true);
  clickModalButton("Cancel");
  await pending;

  for (const file of files) expect(file.path.startsWith("Archive/")).toBe(false);
  expect(notices).toEqual([]);
});

test("bulk confirm continue archives everything", async () => {
  const fixture = makeApp();
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  const files: MockFile[] = [];
  for (let i = 0; i < 11; i++) {
    const file = new MockFile(`note${i}.md`);
    fixture.entries.set(file.path, file);
    files.push(file);
  }
  const pending = (plugin as unknown as { archiveMany(files: MockFile[]): Promise<void> }).archiveMany(files);
  await Bun.sleep(10);
  clickModalButton("Continue");
  await pending;

  for (const file of files) expect(file.path.startsWith("Archive/")).toBe(true);
  expect(notices.some((m) => m.includes("Archived 11 files"))).toBe(true);
});

test("archive failure produces a notice", async () => {
  const fixture = makeApp();
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  plugin.settings.archiveFolder = " ";
  const file = new MockFile("note.md");
  fixture.entries.set(file.path, file);

  expect(await plugin.archive(file as never)).toBe(false);
  expect(notices.some((m) => m.includes("Could not archive"))).toBe(true);
});

test("restore failure produces a notice", async () => {
  const fixture = makeApp();
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  const file = new MockFile("Projects/note.md");
  fixture.entries.set(file.path, file);
  expect(await plugin.archive(file as never)).toBe(true);
  expect(file.path).toBe("Archive/note.md");

  plugin.settings.excludedPaths = "Projects";
  expect(await plugin.restore(file as never)).toBe(false);
  expect(notices.some((m) => m.includes("Could not restore"))).toBe(true);
});

test("archiveMany reports failures", async () => {
  const fixture = makeApp();
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  const good = new MockFile("good.md");
  const bad = new MockFile("Archive/bad.md");
  fixture.entries.set(good.path, good);
  fixture.entries.set(bad.path, bad);

  await (plugin as unknown as { archiveMany(files: MockFile[]): Promise<void> }).archiveMany([good, bad]);

  expect(good.path).toBe("Archive/good.md");
  expect(bad.path).toBe("Archive/bad.md");
  expect(notices.some((m) => m.includes("failed"))).toBe(true);
});

test("restoreMany warns about inferred paths", async () => {
  const fixture = makeApp();
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  const file = new MockFile("Archive/legacy.md");
  fixture.entries.set(file.path, file);

  await (plugin as unknown as { restoreMany(files: MockFile[]): Promise<void> }).restoreMany([file]);

  expect(file.path).toBe("legacy.md");
  expect(notices.some((m) => m.includes("completed with warnings"))).toBe(true);
});

test("closing the delete prompt cancels without touching the file", async () => {
  const fixture = makeApp();
  fixture.app.loadedData = { deleteAction: "ask" };
  const file = new MockFile("note.md");
  fixture.setActive(file);
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();

  const pending = fixture.app.fileManager.promptForDeletion(file);
  await Bun.sleep(20);
  expect(modalButtons.length).toBeGreaterThan(0);
  const modal = modals[modals.length - 1] as unknown as { onClose?: () => void } | undefined;
  if (modal?.onClose) {
    // Simulate closing the modal via the window X: onClose resolves to cancel.
    modal.onClose();
  } else {
    // Fallback when the obsidian mock is shared across test files:
    // Cancel still routes through close() which invokes onClose().
    clickModalButton("Cancel");
  }

  expect(await pending).toBe(false);
  expect(file.path).toBe("note.md");
  expect(fixture.trashed).toEqual([]);
});

test("missing link caches leave attachments in place", async () => {
  const fixture = makeApp();
  fixture.app.loadedData = { archiveAttachments: true };
  const note = new MockFile("note.md");
  const image = new MockFile("image.png");
  const other = new MockFile("other.md");
  for (const file of [note, image, other]) fixture.entries.set(file.path, file);
  fixture.app.metadataCache.resolvedLinks = { [note.path]: { [image.path]: 1 } };
  fixture.app.metadataCache.getFileCache = () => null;
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();

  expect(await plugin.archive(note as never)).toBe(true);
  expect(image.path).toBe("image.png");
});

test("attachment expansion errors do not block batch archives", async () => {
  const fixture = makeApp();
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  const first = new MockFile("first.md");
  const second = new MockFile("second.md");
  fixture.entries.set(first.path, first);
  fixture.entries.set(second.path, second);
  const manager = (plugin as unknown as { archiveManager: { collectAttachments(f: MockFile): Promise<unknown> } }).archiveManager;
  const original = manager.collectAttachments.bind(manager);
  manager.collectAttachments = async (file: MockFile) => {
    if (file.path === "first.md") throw new Error("boom");
    return original(file);
  };

  await (plugin as unknown as { archiveMany(files: MockFile[]): Promise<void> }).archiveMany([first, second]);

  expect(first.path).toBe("Archive/first.md");
  expect(second.path).toBe("Archive/second.md");
});

test("archive warning notice mentions metadata trouble", async () => {
  const fixture = makeApp();
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  const file = new MockFile("note.md");
  fixture.entries.set(file.path, file);
  fixture.app.fileManager.processFrontMatter = async () => {
    throw new Error("bad yaml");
  };

  expect(await plugin.archive(file as never)).toBe(true);
  expect(notices.some((m) => m.includes("but metadata could not be updated"))).toBe(true);
});

test("group restore notice mentions attachments", async () => {
  const fixture = makeApp();
  fixture.app.loadedData = { archiveAttachments: true };
  const note = new MockFile("Projects/note.md");
  const image = new MockFile("Assets/image.png");
  fixture.entries.set(note.path, note);
  fixture.entries.set(image.path, image);
  fixture.app.metadataCache.resolvedLinks = { [note.path]: { [image.path]: 1 } };
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();

  expect(await plugin.archive(note as never)).toBe(true);
  notices.length = 0;
  expect(await plugin.restore(note as never)).toBe(true);
  expect(notices.some((m) => m.includes("attachment"))).toBe(true);
});

test("group restore failure notice mentions failed attachments", async () => {
  const fixture = makeApp();
  fixture.app.loadedData = { archiveAttachments: true };
  const note = new MockFile("Projects/note.md");
  const image = new MockFile("Assets/image.png");
  fixture.entries.set(note.path, note);
  fixture.entries.set(image.path, image);
  fixture.app.metadataCache.resolvedLinks = { [note.path]: { [image.path]: 1 } };
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  expect(await plugin.archive(note as never)).toBe(true);

  plugin.settings.excludedPaths = "Assets";
  notices.length = 0;
  expect(await plugin.restore(note as never)).toBe(true);
  expect(notices.some((m) => m.includes("failed"))).toBe(true);
  expect(note.path).toBe("Projects/note.md");
});
