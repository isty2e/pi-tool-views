import { randomUUID } from "node:crypto";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mergeSettings, validateSettings } from "./model.ts";
import type { Settings, SettingsKey, SettingsPatch, SettingsTarget } from "./model.ts";

interface Layer {
  readonly path: string;
  bytes: string | null | undefined;
  patch: SettingsPatch;
  diagnostic: string | undefined;
}

export interface SettingsDraft {
  readonly target: SettingsTarget;
  readonly patch: SettingsPatch;
  readonly dirty: boolean;
}

export type SaveResult =
  | { readonly kind: "saved" }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to access settings.";
}

export class SettingsStore {
  private readonly layers: Record<SettingsTarget, Layer>;
  private readonly listeners = new Set<() => void>();
  private readonly watchers: (() => void)[] = [];
  private editing: { target: SettingsTarget; patch: SettingsPatch; baseline: string | null | undefined; dirty: boolean } | undefined;
  private disposed = false;
  private saving = false;
  notificationError: string | undefined;

  constructor(personalPath: string, projectPath: string, watch = true) {
    this.layers = {
      personal: { path: personalPath, bytes: undefined, patch: {}, diagnostic: undefined },
      project: { path: projectPath, bytes: undefined, patch: {}, diagnostic: undefined },
    };
    this.reload();

    if (watch) {
      for (const layer of Object.values(this.layers)) {
        const listener = () => this.reload();
        watchFile(layer.path, { persistent: false, interval: 500 }, listener);
        this.watchers.push(() => unwatchFile(layer.path, listener));
      }
    }
  }

  get committed(): Settings {
    return mergeSettings(this.layers.personal.patch, this.layers.project.patch);
  }

  get effective(): Settings {
    const draft = this.editing;
    return mergeSettings(
      draft?.target === "personal" ? draft.patch : this.layers.personal.patch,
      draft?.target === "project" ? draft.patch : this.layers.project.patch,
    );
  }

  get draft(): SettingsDraft | undefined {
    const draft = this.editing;
    return draft ? { target: draft.target, patch: { ...draft.patch }, dirty: draft.dirty } : undefined;
  }

  get diagnostics(): readonly string[] {
    return Object.entries(this.layers).flatMap(([target, layer]) => layer.diagnostic ? [`${target}: ${layer.diagnostic}`] : []);
  }

  path(target: SettingsTarget): string {
    return this.layers[target].path;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reload(): void {
    if (this.disposed) return;

    for (const layer of Object.values(this.layers)) {
      let bytes: string | null;
      try {
        bytes = readFileSync(layer.path, "utf8");
      } catch (error) {
        if (!missing(error)) {
          layer.diagnostic = errorMessage(error);
          layer.bytes = undefined;
          continue;
        }
        bytes = null;
      }

      if (bytes === layer.bytes) continue;
      layer.bytes = bytes;
      try {
        const parsed = validateSettings(bytes === null ? {} : JSON.parse(bytes));
        if (!parsed.ok) {
          layer.diagnostic = parsed.message;
          continue;
        }
        layer.patch = parsed.value;
        layer.diagnostic = undefined;
      } catch (error) {
        layer.diagnostic = errorMessage(error);
      }
    }

    this.notify();
  }

  begin(target: SettingsTarget): void {
    if (this.saving) return;
    this.editing = { target, patch: { ...this.layers[target].patch }, baseline: this.layers[target].bytes, dirty: false };
    this.notify();
  }

  edit<K extends SettingsKey>(key: K, value: Settings[K] | undefined): void {
    if (!this.editing || this.saving) return;
    const patch = { ...this.editing.patch };
    if (value === undefined) delete patch[key];
    else patch[key] = value;

    const checked = validateSettings(patch);
    if (!checked.ok) throw new Error(checked.message);
    this.editing.patch = checked.value;
    this.editing.dirty = true;
    this.notify();
  }

  cancel(): void {
    if (this.saving) return;
    this.editing = undefined;
    this.reload();
  }

  async save(): Promise<SaveResult> {
    const draft = this.editing;
    if (!draft || this.saving) return { kind: "error", message: "No editable draft." };
    const layer = this.layers[draft.target];
    if (draft.baseline === undefined) return { kind: "error", message: "Reload the readable target before saving." };

    this.saving = true;
    let temporary: string | undefined;
    try {
      const target = await lstat(layer.path).catch((error: unknown) => {
        if (missing(error)) return undefined;
        throw error;
      });
      if (target?.isSymbolicLink()) return { kind: "error", message: "The settings target is a symbolic link. Edit it directly instead." };
      const current = await readFile(layer.path, "utf8").catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      if (current !== draft.baseline) {
        return { kind: "conflict", message: "The target changed outside Tool Views. Review it, then reload the draft." };
      }

      const bytes = `${JSON.stringify(draft.patch, null, 2)}\n`;
      await mkdir(dirname(layer.path), { recursive: true });
      temporary = join(dirname(layer.path), `.tool-views-${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes, "utf8");
      } finally {
        await file.close();
      }
      await rename(temporary, layer.path);
      temporary = undefined;

      layer.bytes = bytes;
      layer.patch = { ...draft.patch };
      layer.diagnostic = undefined;
      this.editing = undefined;
      this.notify();
      return { kind: "saved" };
    } catch (error) {
      return { kind: "error", message: errorMessage(error) };
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
      this.saving = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const stop of this.watchers) stop();
    this.watchers.length = 0;
    this.listeners.clear();
    this.editing = undefined;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.notificationError = errorMessage(error);
      }
    }
  }
}
