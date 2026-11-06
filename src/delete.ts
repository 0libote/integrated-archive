import { around } from "monkey-around";
import type { DeleteAction } from "./path";

export type DeleteChoice = "archive" | "delete" | "cancel";

export interface DeletionManager<File> {
  promptForDeletion(file: File): Promise<boolean>;
  trashFile(file: File): Promise<void>;
}

export interface DeletionInterceptorOptions<AbstractFile, File extends AbstractFile> {
  archive(file: File): Promise<boolean>;
  choose(file: File): Promise<DeleteChoice>;
  getAction(): DeleteAction;
  isArchived(file: File): boolean;
  isFile(file: AbstractFile): file is File;
}

export function installDeletionInterceptor<AbstractFile, File extends AbstractFile>(
  manager: DeletionManager<AbstractFile>,
  options: DeletionInterceptorOptions<AbstractFile, File>,
): () => void {
  const keyOf = (file: AbstractFile): string => (file as { path: string }).path ?? String(file);
  const explicitDeletes = new Set<string>();
  const archives = new Map<string, Promise<boolean>>();
  const archiveOnce = (file: File): Promise<boolean> => {
    const key = keyOf(file);
    const pending = archives.get(key);
    if (pending) return pending;
    const operation = Promise.resolve().then(() => options.archive(file));
    archives.set(key, operation);
    void operation.then(() => archives.delete(key), () => archives.delete(key));
    return operation;
  };

  return around(manager, {
    promptForDeletion: (next) => async function (
      this: DeletionManager<AbstractFile>,
      file: AbstractFile,
    ): Promise<boolean> {
      const action = options.getAction();
      if (options.isFile(file) && archives.has(keyOf(file))) {
        await archiveOnce(file);
        return false;
      }
      if (!options.isFile(file) || options.isArchived(file) || action === "delete") {
        return next.call(this, file);
      }
      // Archive mode: move to the archive and consume the delete so callers
      // using the two-step `if (await prompt) await trash` flow do not trash
      // the just-archived file. Callers that only await the prompt (ignoring
      // the result) still get the side effect. Returning false means "do not
      // proceed with deletion" in both flows.
      if (action === "archive") {
        // A failed archive must not make the vault undeletable: fall back to
        // the normal delete flow so the user can still act.
        if (await archiveOnce(file)) return false;
        return next.call(this, file);
      }

      const choice = await options.choose(file);
      if (choice === "archive") {
        // The user chose archive, not delete: stay put even when archiving
        // fails (the failure is already shown as a Notice by archive()).
        await archiveOnce(file);
        return false;
      }
      if (choice === "delete") {
        // Trash here and consume: two-step callers seeing `false` skip their
        // own trashFile (no double-trash), one-step callers ignoring the
        // result still get the deletion as a side effect.
        const key = keyOf(file);
        explicitDeletes.add(key);
        try {
          await this.trashFile(file);
        } finally {
          explicitDeletes.delete(key);
        }
        return false;
      }
      return false;
    },
    trashFile: (next) => async function (
      this: DeletionManager<AbstractFile>,
      file: AbstractFile,
    ): Promise<void> {
      const action = options.getAction();
      if (explicitDeletes.has(keyOf(file))) return next.call(this, file);
      if (options.isFile(file) && archives.has(keyOf(file))) {
        await archiveOnce(file);
        return;
      }
      // Direct trashFile calls (programmatic deletes, some third-party menus)
      // bypass promptForDeletion entirely. In "archive automatically" mode,
      // redirect files to the archive instead of deleting them. Folders,
      // archived files, and other modes pass through untouched.
      if (
        action === "archive"
        && options.isFile(file)
        && !options.isArchived(file)
      ) {
        if (await archiveOnce(file)) return;
      }
      return next.call(this, file);
    },
  });
}
