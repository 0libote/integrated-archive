import type { DeleteAction } from "./path";

export interface ArchiveSettings {
  archiveFolder: string;
  preserveFolders: boolean;
  deleteAction: DeleteAction;
  showArchiveMenu: boolean;
  addTag: boolean;
  tag: string;
  addArchivedDate: boolean;
  archivedProperty: string;
  addCreatedDate: boolean;
  createdProperty: string;
  addModifiedDate: boolean;
  modifiedProperty: string;
  dateFormat: string;
}

export const DEFAULT_SETTINGS: ArchiveSettings = {
  archiveFolder: "Archive",
  preserveFolders: false,
  deleteAction: "ask",
  showArchiveMenu: true,
  addTag: true,
  tag: "archived",
  addArchivedDate: true,
  archivedProperty: "archived",
  addCreatedDate: true,
  createdProperty: "created",
  addModifiedDate: true,
  modifiedProperty: "modified",
  dateFormat: "YYYY-MM-DD",
};
