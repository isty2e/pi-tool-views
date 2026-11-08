import type { FileReference, RequestView } from "../presentation.ts";
import type { PreparedRequest } from "./prepared.ts";
import { fileReference } from "../projection/file-context.ts";

export interface PreparedFileTarget {
  readonly path: string;
  readonly moveTo?: string;
  readonly before: FileReference;
  readonly after: FileReference;
}

export interface PreparedFiles {
  readonly request: RequestView;
  readonly directory: string;
  readonly targets: readonly PreparedFileTarget[];
  readonly signature: string;
}

export function prepareFiles(prepared: PreparedRequest, directory: string): PreparedFiles {
  const context = "fileContext" in prepared.request ? prepared.request.fileContext : undefined;
  const targets = prepared.changes?.targets.flatMap(target => target ? [{
    path: target.path, ...(target.moveTo ? { moveTo: target.moveTo } : {}),
    before: fileReference(target.path, directory, context, target.fileContext),
    after: fileReference(target.moveTo ?? target.path, directory, context, target.fileContext),
  }] : []) ?? [];
  return { request: prepared.request, directory, targets, signature: JSON.stringify([prepared.request, targets]) };
}
