import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { App, PluginManifest } from "obsidian";

type Cleanup = () => void;
type EventCallback = (...args: unknown[]) => unknown;

interface MockCommand {
  id: string;
  [key: string]: unknown;
}

const notices: string[] = [];

class MockAbstractFile {
  constructor(public path: string, public name: string) {}
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
    callback(new MockButton());
    return this;
  }
}

class MockButton {
  onClick() { return this; }
  setButtonText() { return this; }
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
  ]);
  expect(fixture.events.has("workspace:file-menu")).toBe(true);
  expect(fixture.events.has("workspace:files-menu")).toBe(true);
  expect(fixture.events.has("vault:rename")).toBe(true);
});

test("archives and restores through the plugin integration", async () => {
  const fixture = makeApp();
  const file = new MockFile("Projects/note.md");
  file.frontmatter = { created: "keep-me", tags: ["active"] };
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
