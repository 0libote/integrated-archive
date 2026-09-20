export function addCollisionSuffix(path: string, number: number): string {
  if (number === 0) return path;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const hasExtension = dot > slash + 1;
  const split = hasExtension ? dot : path.length;
  return `${path.slice(0, split)} (${number})${path.slice(split)}`;
}

export function isPathInFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

export type DeleteAction = "ask" | "archive" | "delete";

export function resolveDeleteAction(value?: string, oldPrompt?: boolean): DeleteAction {
  return value === "archive" || value === "delete" || value === "ask"
    ? value
    : oldPrompt === false ? "delete" : "ask";
}
