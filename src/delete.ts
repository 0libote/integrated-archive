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
  return around(manager, {
    promptForDeletion: (next) => async function (
      this: DeletionManager<AbstractFile>,
      file: AbstractFile,
    ): Promise<boolean> {
      if (!options.isFile(file) || options.isArchived(file) || options.getAction() === "delete") {
        return next.call(this, file);
      }
      if (options.getAction() === "archive") return options.archive(file);

      const choice = await options.choose(file);
      if (choice === "archive") return options.archive(file);
      if (choice === "delete") await this.trashFile(file);
      return choice === "delete";
    },
  });
}
