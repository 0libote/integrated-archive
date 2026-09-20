import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { App, PluginManifest } from "obsidian";

type Cleanup = () => void;
type EventCallback = (...args: unknown[]) => unknown;

interface MockCommand {
  id: string;
  [key: string]: unknown;
}

const notices: string[] = [];
const modalButtons: MockButton[] = [];

function clickModalButton(text: string): void {
  modalButtons.find((button) => button.text === text)?.click();
}

async function openDeletePrompt(): Promise<{ fixture: ReturnType<typeof makeApp>; file: MockFile; result: Promise<boolean> }> {
  const fixture = makeApp();
  fixture.app.loadedData = { deleteAction: "ask" };
  const file = new MockFile("note.md");
  fixture.setActive(file);
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  const result = fixture.app.fileManager.promptForDeletion(file);
  return { fixture, file, result };
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
  constructor(public app: TestApp) {}
  close() {}
  open() {}
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
    getFileCache(file: MockFile): { frontmatter: Record<string, unknown> } | null;
  };
  savedData: unknown;
  vault: {
    createFolder(path: string): Promise<void>;
    getAbstractFileByPath(path: string): MockAbstractFile | null;
    on(name: string, callback: EventCallback): { cleanup: Cleanup };
  };
  workspace: {
    getActiveFile(): MockFile | null;
    on(name: string, callback: EventCallback): { cleanup: Cleanup };
  };
}

function makeApp() {
  const entries = new Map<string, MockAbstractFile>();
  const events = new Map<string, EventCallback>();
  const folders = new Set<string>();
  const trashed: string[] = [];
  let activeFile: MockFile | null = null;
  const app: TestApp = {
    loadedData: null,
    savedData: null,
    metadataCache: {
      getFileCache: (file) => ({ frontmatter: file.frontmatter }),
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
        file.path = destination;
        file.name = destination.slice(destination.lastIndexOf("/") + 1);
        entries.set(destination, file);
      },
      async trashFile(file) {
        trashed.push(file.path);
        entries.delete(file.path);
      },
    },
    vault: {
      async createFolder(path) {
        folders.add(path);
        entries.set(path, new MockAbstractFile(path, path.slice(path.lastIndexOf("/") + 1)));
      },
      getAbstractFileByPath: (path) => entries.get(path) ?? null,
      on(name, callback) {
        events.set(`vault:${name}`, callback);
        return { cleanup: () => events.delete(`vault:${name}`) };
      },
    },
    workspace: {
      getActiveFile: () => activeFile,
      on(name, callback) {
        events.set(`workspace:${name}`, callback);
        return { cleanup: () => events.delete(`workspace:${name}`) };
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
    trashed,
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

test("loads sanitized settings and registers commands and menus", async () => {
  const fixture = makeApp();
  fixture.app.loadedData = { archiveFolder: "../invalid", promptOnDelete: false };
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);

  await plugin.onload();

  expect(plugin.settings.archiveFolder).toBe("Archive");
  expect(plugin.settings.deleteAction).toBe("delete");
  expect((plugin as unknown as MockPlugin).commands.map((command) => command.id)).toEqual([
    "archive-current-file",
    "restore-current-file",
    "undo-last-archive",
    "archive-current-folder",
  ]);
  expect(fixture.events.has("workspace:file-menu")).toBe(true);
  expect(fixture.events.has("workspace:files-menu")).toBe(true);
  expect(fixture.events.has("vault:rename")).toBe(true);
});

test("archives and restores through the plugin integration", async () => {
  const fixture = makeApp();
  const file = new MockFile("Projects/note.md");
  file.frontmatter = { created: "keep-me", tags: ["active"] };
  const originalFrontmatter = structuredClone(file.frontmatter);
  fixture.setActive(file);
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();

  expect(await plugin.archive(file as never)).toBe(true);
  expect(file.path).toBe("Archive/note.md");
  expect(file.frontmatter.created).toBe("keep-me");
  expect(file.frontmatter.tags).toEqual(["active", "archived"]);
  expect(plugin.settings.archiveHistory).toHaveLength(1);
  expect(typeof plugin.settings.archiveHistory[0]?.archivedAt).toBe("number");
  expect(plugin.settings.archiveHistory[0]?.archivedPath).toBe("Archive/note.md");
  expect(plugin.settings.archiveHistory[0]?.originalPath).toBe("Projects/note.md");

  expect(await plugin.restore(file as never)).toBe(true);
  expect(file.path).toBe("Projects/note.md");
  expect(file.frontmatter).toEqual(originalFrontmatter);
  expect(plugin.settings.archiveHistory).toEqual([]);
  expect(notices).toContain("Archived to Archive/note.md");
  expect(notices).toContain("Restored to Projects/note.md");
});

test("routes delete actions through archive mode and restores the original method on cleanup", async () => {
  const fixture = makeApp();
  const originalPrompt = fixture.app.fileManager.promptForDeletion;
  const file = new MockFile("note.md");
  fixture.setActive(file);
  fixture.app.loadedData = { deleteAction: "archive" };
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();

  expect(await fixture.app.fileManager.promptForDeletion(file)).toBe(true);
  expect(file.path).toBe("Archive/note.md");
  expect(fixture.trashed).toEqual([]);

  const pluginState = plugin as unknown as MockPlugin;
  for (const cleanup of pluginState.cleanups.reverse()) cleanup();
  pluginState.cleanups = [];
  expect(fixture.app.fileManager.promptForDeletion).toBe(originalPrompt);
});

test("adds the correct single-file and multi-file menu actions", async () => {
  const fixture = makeApp();
  const active = new MockFile("one.md");
  const archived = new MockFile("Archive/two.md");
  fixture.entries.set(active.path, active);
  fixture.entries.set(archived.path, archived);
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();

  const singleTitles: string[] = [];
  const fileMenu = { addItem: (callback: (item: MenuItem) => void) => callback(new MenuItem(singleTitles)) };
  fixture.events.get("workspace:file-menu")?.(fileMenu, active);
  fixture.events.get("workspace:file-menu")?.(fileMenu, archived);
  expect(singleTitles).toEqual(["Archive", "Restore from archive"]);

  const multiTitles: string[] = [];
  const filesMenu = { addItem: (callback: (item: MenuItem) => void) => callback(new MenuItem(multiTitles)) };
  fixture.events.get("workspace:files-menu")?.(filesMenu, [active, archived]);
  expect(multiTitles).toEqual(["Archive 1 file", "Restore 1 file"]);
});

test("offers to archive every file in a folder, including nested files", async () => {
  const fixture = makeApp();
  const folder = new MockFolder("Projects", "Projects");
  const first = new MockFile("Projects/one.md");
  const nested = new MockFolder("Projects/Sub", "Sub");
  const deep = new MockFile("Projects/Sub/two.md");
  const archived = new MockFile("Archive/three.md");
  first.parent = folder;
  nested.parent = folder;
  deep.parent = nested;
  folder.children = [first, nested];
  nested.children = [deep];
  fixture.entries.set(first.path, first);
  fixture.entries.set(deep.path, deep);
  fixture.entries.set(archived.path, archived);
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();

  const titles: string[] = [];
  const menu = { addItem: (callback: (item: MenuItem) => void) => callback(new MenuItem(titles)) };
  fixture.events.get("workspace:file-menu")?.(menu, folder);

  expect(titles).toEqual(["Archive 2 files"]);
});

test("does not offer folder archiving inside the archive", async () => {
  const fixture = makeApp();
  const folder = new MockFolder("Archive/Projects", "Projects");
  const file = new MockFile("Archive/Projects/one.md");
  file.parent = folder;
  folder.children = [file];
  fixture.entries.set(file.path, file);
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();

  const titles: string[] = [];
  const menu = { addItem: (callback: (item: MenuItem) => void) => callback(new MenuItem(titles)) };
  fixture.events.get("workspace:file-menu")?.(menu, folder);

  expect(titles).toEqual([]);
});

test("hides archive actions for protected paths", async () => {
  const fixture = makeApp();
  fixture.app.loadedData = { excludedPaths: "Private" };
  const file = new MockFile("Private/secret.md");
  fixture.setActive(file);
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();

  const titles: string[] = [];
  const menu = { addItem: (callback: (item: MenuItem) => void) => callback(new MenuItem(titles)) };
  fixture.events.get("workspace:file-menu")?.(menu, file);
  expect(titles).toEqual([]);

  const command = (plugin as unknown as MockPlugin).commands.find((item) => item.id === "archive-current-file");
  const check = command?.checkCallback as ((checking: boolean) => boolean) | undefined;
  expect(check?.(true)).toBe(false);
});

test("asks before deleting and archives when chosen", async () => {
  const { fixture, file, result } = await openDeletePrompt();
  clickModalButton("Archive");

  expect(await result).toBe(true);
  expect(file.path).toBe("Archive/note.md");
  expect(fixture.trashed).toEqual([]);
});

test("deletes through Obsidian trash when the prompt chooses delete", async () => {
  const { fixture, file, result } = await openDeletePrompt();
  clickModalButton("Delete");

  expect(await result).toBe(true);
  expect(file.path).toBe("note.md");
  expect(fixture.trashed).toEqual(["note.md"]);
});

test("cancels deletion and leaves the file in place", async () => {
  const { file, result } = await openDeletePrompt();
  clickModalButton("Cancel");

  expect(await result).toBe(false);
  expect(file.path).toBe("note.md");
});

test("archives every eligible file through the folder command", async () => {
  const fixture = makeApp();
  const folder = new MockFolder("Projects", "Projects");
  const first = new MockFile("Projects/one.md");
  const second = new MockFile("Projects/two.md");
  first.parent = folder;
  second.parent = folder;
  folder.children = [first, second];
  fixture.entries.set(first.path, first);
  fixture.entries.set(second.path, second);
  fixture.setActive(first);
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();

  const command = (plugin as unknown as MockPlugin).commands.find((item) => item.id === "archive-current-folder");
  const check = command?.checkCallback as ((checking: boolean) => boolean) | undefined;
  expect(check?.(true)).toBe(true);
  check?.(false);
  await Bun.sleep(10);

  expect(first.path).toBe("Archive/one.md");
  expect(second.path).toBe("Archive/two.md");
  expect(notices).toContain("Archived 2 files.");
});

test("undoes the last archive through the command", async () => {
  const fixture = makeApp();
  const file = new MockFile("Projects/note.md");
  fixture.setActive(file);
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();
  await plugin.archive(file as never);
  expect(file.path).toBe("Archive/note.md");

  const command = (plugin as unknown as MockPlugin).commands.find((item) => item.id === "undo-last-archive");
  const check = command?.checkCallback as ((checking: boolean) => boolean) | undefined;
  expect(check?.(true)).toBe(true);
  check?.(false);
  await Bun.sleep(10);

  expect(file.path).toBe("Projects/note.md");
});

test("reloads settings when they change outside the plugin", async () => {
  const fixture = makeApp();
  fixture.app.loadedData = { archiveFolder: "Archive" };
  plugin = new IntegratedArchivePlugin(fixture.app as unknown as App, {} as PluginManifest);
  await plugin.onload();

  fixture.app.loadedData = { archiveFolder: "Storage/Archive" };
  await plugin.onExternalSettingsChange();

  expect(plugin.settings.archiveFolder).toBe("Storage/Archive");
});

class MenuItem {
  constructor(private readonly titles: string[]) {}
  onClick() { return this; }
  setIcon() { return this; }
  setSection() { return this; }
  setTitle(title: string) {
    this.titles.push(title);
    return this;
  }
}
