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
  // Re-entrancy guard: actions performed inside promptForDeletion (archive or
  // trashFile) must not re-enter the trashFile interceptor below.
  let handling = false;

  return around(manager, {
    promptForDeletion: (next) => async function (
      this: DeletionManager<AbstractFile>,
      file: AbstractFile,
    ): Promise<boolean> {
      if (handling) return next.call(this, file);
      if (!options.isFile(file) || options.isArchived(file) || options.getAction() === "delete") {
        return next.call(this, file);
      }
      // Archive mode: move to the archive and consume the delete so callers
      // using the two-step `if (await prompt) await trash` flow do not trash
      // the just-archived file. Callers that only await the prompt (ignoring
      // the result) still get the side effect. Returning false means "do not
      // proceed with deletion" in both flows.
      if (options.getAction() === "archive") {
        handling = true;
        try {
          await options.archive(file);
        } finally {
          handling = false;
        }
        return false;
      }

      const choice = await options.choose(file);
      if (choice === "archive") {
        handling = true;
        try {
          await options.archive(file);
        } finally {
          handling = false;
        }
        return false;
      }
      if (choice === "delete") {
        // Trash here and consume: two-step callers seeing `false` skip their
        // own trashFile (no double-trash), one-step callers ignoring the
        // result still get the deletion as a side effect.
        handling = true;
        try {
          await this.trashFile(file);
        } finally {
          handling = false;
        }
        return false;
      }
      return false;
    },
    trashFile: (next) => async function (
      this: DeletionManager<AbstractFile>,
      file: AbstractFile,
    ): Promise<void> {
      if (handling) return next.call(this, file);
      // Direct trashFile calls (programmatic deletes, some third-party menus)
      // bypass promptForDeletion entirely. In "archive automatically" mode,
      // redirect files to the archive instead of deleting them. Folders,
      // archived files, and other modes pass through untouched.
      if (
        options.getAction() === "archive"
        && options.isFile(file)
        && !options.isArchived(file)
      ) {
        handling = true;
        try {
          await options.archive(file);
        } finally {
          handling = false;
        }
        return;
      }
      return next.call(this, file);
    },
  });
}
