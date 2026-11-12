import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { App, PluginManifest } from "obsidian";

type Cleanup = () => void;
type EventCallback = (...args: unknown[]) => unknown;

const notices: string[] = [];
const modalButtons: Array<{ text: string; click(): void }> = [];

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

class MockExternalFile extends MockFile {
  getRealPath() {
    return `/external/${this.path}`;
  }
}

class MockPlugin {
  app: TestApp;
  cleanups: Cleanup[] = [];
  commands: Array<{ id: string; [key: string]: unknown }> = [];
  settingTabs: unknown[] = [];
  constructor(app: TestApp) {
    this.app = app;
  }
  addCommand(command: { id: string }) {
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
}

class MockModal {
  contentEl = { createEl: () => undefined, empty: () => undefined };
  constructor(public app: TestApp) {}
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
  onClick(callback: () => void) {
    this.callback = callback;
    return this;
  }
  setButtonText(text: string) {
    this.text = text;
    return this;
  }
  setCta() {
    return this;
  }
  setDestructive() {
    return this;
  }
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
    resolvedLinks: Record<string, Record<string, number>>;
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
  let activeFile: MockFile | null = null;
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
      async promptForDeletion() {
        return true;
      },
      async renameFile(file, destination) {
        entries.delete(file.path);
        file.path = destination;
        file.name = destination.slice(destination.lastIndexOf("/") + 1);
        entries.set(destination, file);
      },
      async trashFile() {},
    },
    vault: {
      async createFolder(path) {
        entries.set(path, new MockAbstractFile(path, path));
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
        return true;
      },
      on(name, callback) {
        events.set(`workspace:${name}`, callback);
        return { cleanup: () => events.delete(`workspace:${name}`) };
      },
      onLayoutReady(callback) {
        callback();
      },
    },
  };
  return {
    app, entries, events,
    setActive(file: MockFile | null) {
      activeFile = file;
      if (file) entries.set(file.path, file);
    },
  };
}

let plugin: InstanceType<typeof IntegratedArchivePlugin> | undefined;

beforeEach(() => {
  notices.length = 0;
  modalButtons.length = 0;
  mock.restore();
});

afterEach(() => {
  if (plugin) {
    for (const cleanup of (plugin as unknown as MockPlugin).cleanups.reverse()) cleanup();
    plugin = undefined;
  }
});

function clickButton(text: string) {
  modalButtons.find((button) => button.text === text)?.click();
}

test("archive survives a missing resolvedLinks index", async () => {
  const fixture = makeApp();
  fixture.app.loadedData = { archiveAttachments: true };
  const note = new MockFile("Projects/note.md");
  const image = new MockFile("Assets/image.png");
  fixture.entries.set(note.path, note);
  fixture.entries.set(image.path, image);
  (fixture.app.metadataCache as unknown as { resolvedLinks: undefined }).resolvedLinks = undefined;
  fixture.app.metadataCache.getFileCache = () => ({ frontmatter: note.frontmatter, links: [{ link: "Assets/image.png" }] });
  fixture.app.metadataCache.getFirstLinkpathDest = () => null;
  fixture.setActive(note);
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  expect(await plugin.archive(note as never)).toBe(true);
  expect(note.path).toBe("Archive/note.md");
});

test("folder batch skips files from outside the vault", async () => {
  const fixture = makeApp();
  fixture.app.loadedData = { archiveAttachments: false };
  const folder = new MockFolder("Projects", "Projects");
  const note = new MockFile("Projects/note.md");
  const external = new MockExternalFile("Projects/outside.md");
  note.parent = folder;
  external.parent = folder;
  folder.children = [note, external];
  fixture.entries.set(folder.path, folder);
  fixture.entries.set(note.path, note);
  fixture.entries.set(external.path, external);
  fixture.setActive(note);
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  await (plugin as unknown as { archiveMany(files: MockFile[]): Promise<void> }).archiveMany([note, external]);
  expect(note.path).toBe("Archive/note.md");
  expect(external.path).toBe("Projects/outside.md");
});

test("shared attachment claimed by two notes in one batch stays ungrouped", async () => {
  const fixture = makeApp();
  fixture.app.loadedData = { archiveAttachments: true, includeSharedAttachments: true };
  const first = new MockFile("first.md");
  const second = new MockFile("second.md");
  const image = new MockFile("image.png");
  for (const file of [first, second, image]) fixture.entries.set(file.path, file);
  fixture.app.metadataCache.resolvedLinks = {
    [first.path]: { [image.path]: 1 },
    [second.path]: { [image.path]: 1 },
  };
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  const expanded = await (plugin as unknown as {
    expandWithAttachments(files: MockFile[]): Promise<{ groups: Map<string, string>; items: MockFile[] }>;
  }).expandWithAttachments([first, second]);
  expect(expanded.items.map((file) => file.path)).toContain(image.path);
  expect(expanded.groups.get(image.path)).toBe(undefined);
  expect(expanded.groups.get(first.path)).toBeTruthy();
  expect(expanded.groups.get(second.path)).toBeTruthy();
  expect(expanded.groups.get(first.path)).not.toBe(expanded.groups.get(second.path));
});

test("explicitly selected shared attachment stays ungrouped", async () => {
  const fixture = makeApp();
  fixture.app.loadedData = { archiveAttachments: true, includeSharedAttachments: true };
  const first = new MockFile("first.md");
  const second = new MockFile("second.md");
  const image = new MockFile("image.png");
  for (const file of [first, second, image]) fixture.entries.set(file.path, file);
  fixture.app.metadataCache.resolvedLinks = {
    [first.path]: { [image.path]: 1 },
    [second.path]: { [image.path]: 1 },
  };
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  const expanded = await (plugin as unknown as {
    expandWithAttachments(files: MockFile[]): Promise<{ groups: Map<string, string>; items: MockFile[] }>;
  }).expandWithAttachments([first, second, image]);
  // The image was explicitly selected so it is still archived, but it must
  // not belong to either note's group.
  expect(expanded.items.map((file) => file.path)).toContain(image.path);
  expect(expanded.groups.get(image.path)).toBe(undefined);
});

test("single note with many attachments asks for confirmation", async () => {
  const fixture = makeApp();
  fixture.app.loadedData = { archiveAttachments: true, includeSharedAttachments: true };
  const note = new MockFile("note.md");
  fixture.entries.set(note.path, note);
  const outgoing: Record<string, Record<string, number>> = { [note.path]: {} };
  for (let i = 0; i < 11; i++) {
    const image = new MockFile(`image${i}.png`);
    fixture.entries.set(image.path, image);
    outgoing[note.path]![image.path] = 1;
    fixture.app.metadataCache.resolvedLinks[image.path] = {};
  }
  fixture.app.metadataCache.resolvedLinks = outgoing;
  fixture.setActive(note);
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  const pending = plugin.archive(note as never);
  await Bun.sleep(10);
  expect(modalButtons.some((button) => button.text === "Continue")).toBe(true);
  clickButton("Cancel");
  expect(await pending).toBe(false);
  expect(note.path).toBe("note.md");
});
