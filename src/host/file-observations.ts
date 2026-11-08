import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { PreparedFiles } from "./file-targets.ts";

const MIB = 1024 * 1024;
interface ObservationLimits { readonly fileBytes: number; readonly totalBytes: number; readonly calls: number; readonly queuedReads: number; readonly concurrentReads: number; readonly phaseMs: number }
export const observationLimits: ObservationLimits = { fileBytes: 8 * MIB, totalBytes: 32 * MIB, calls: 32, queuedReads: 32, concurrentReads: 2, phaseMs: 100 };
type Phase = "before" | "after";
interface CapturedText { readonly text: string; readonly bytes: number }
interface PhaseReads {
  readonly files: Map<string, CapturedText>;
  readonly canonical: Map<string, Promise<CapturedText | undefined>>;
  bytes: number;
  pending?: Promise<void>;
}
interface Capture {
  readonly key: string;
  readonly controller: AbortController;
  readonly before: PhaseReads;
  readonly after: PhaseReads;
  readonly claims: Set<string>;
  readonly preflight: PreparedFiles;
  executed?: PreparedFiles;
  overlapping: boolean;
  finished: boolean;
}
export interface CapturedFiles {
  readonly before: ReadonlyMap<string, CapturedText>;
  readonly after: ReadonlyMap<string, CapturedText>;
  release(): void;
}

function phaseReads(): PhaseReads { return { files: new Map(), canonical: new Map(), bytes: 0 }; }

/** Volatile, invocation-scoped observations; read failures never become execution failures. */
export class FileObservations {
  private readonly limits: ObservationLimits;
  private readonly captures = new Map<string, Capture>();
  private readonly writers = new Map<string, Set<Capture>>();
  private readonly queue: { readonly capture: Capture; readonly run: () => Promise<void>; readonly done: () => void }[] = [];
  private active = 0;
  private reserved = 0;
  private retained = 0;

  constructor(limits: ObservationLimits = observationLimits) { this.limits = limits; }

  keys(): IterableIterator<string> { return this.captures.keys(); }

  directory(key: string): string | undefined { return this.captures.get(key)?.preflight.directory; }

  async preflight(key: string, files: PreparedFiles): Promise<void> {
    if (this.captures.has(key) || this.captures.size >= this.limits.calls) return;
    const capture: Capture = { key, preflight: files, controller: new AbortController(), before: phaseReads(), after: phaseReads(),
      claims: new Set(), overlapping: false, finished: false };
    this.captures.set(key, capture);
    for (const target of files.targets) for (const reference of [target.before, target.after]) {
      if (reference.kind === "local") this.claim(capture, reference.absolutePath);
    }
    await this.capture(capture, "before", files);
  }

  async executed(key: string, files: PreparedFiles): Promise<void> {
    const capture = this.captures.get(key);
    if (!capture || capture.executed || capture.controller.signal.aborted) return;
    capture.executed = files;
    if (capture.preflight.signature !== files.signature) this.releasePhase(capture.before);
    for (const target of files.targets) for (const reference of [target.before, target.after]) {
      if (reference.kind === "local") this.claim(capture, reference.absolutePath);
    }
    await this.capture(capture, "after", files);
  }

  finish(key: string): void {
    const capture = this.captures.get(key);
    if (!capture) return;
    capture.finished = true;
    this.unclaim(capture);
    if (!capture.executed) this.discard(key);
  }

  take(key: string, expected: PreparedFiles): CapturedFiles | undefined {
    const capture = this.captures.get(key);
    if (!capture) return undefined;
    if (!capture.finished || capture.overlapping || capture.controller.signal.aborted || capture.executed?.signature !== expected.signature) {
      this.discard(key);
      return undefined;
    }
    return { before: capture.before.files, after: capture.after.files, release: () => {
      if (this.captures.get(key) === capture) this.discard(key);
    } };
  }

  discard(key: string): void {
    const capture = this.captures.get(key);
    if (!capture) return;
    this.captures.delete(key);
    capture.controller.abort();
    this.unclaim(capture);
    this.releasePhase(capture.before);
    this.releasePhase(capture.after);
    this.pump();
  }

  reset(): void { for (const key of this.captures.keys()) this.discard(key); }

  private current(capture: Capture): boolean { return this.captures.get(capture.key) === capture && !capture.controller.signal.aborted; }

  private claim(capture: Capture, address: string): void {
    if (capture.finished || !this.current(capture) || capture.claims.has(address)) return;
    let owners = this.writers.get(address);
    if (!owners) { owners = new Set(); this.writers.set(address, owners); }
    for (const owner of owners) { owner.overlapping = true; capture.overlapping = true; }
    owners.add(capture);
    capture.claims.add(address);
  }

  private unclaim(capture: Capture): void {
    for (const address of capture.claims) {
      const owners = this.writers.get(address);
      owners?.delete(capture);
      if (!owners?.size) this.writers.delete(address);
    }
    capture.claims.clear();
  }

  private releasePhase(phase: PhaseReads): void {
    this.retained -= phase.bytes;
    phase.bytes = 0;
    phase.files.clear();
    phase.canonical.clear();
  }

  private async capture(capture: Capture, phaseName: Phase, files: PreparedFiles): Promise<void> {
    const phase = capture[phaseName];
    if (phase.pending) return phase.pending;
    const addresses = new Set(files.targets.flatMap(target => {
      const reference = target[phaseName];
      return reference.kind === "local" ? [reference.absolutePath] : [];
    }));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const jobs = [...addresses].map(address => this.enqueue(capture, async () => {
      let canonical: string;
      try { canonical = await realpath(address); }
      catch {
        try { canonical = resolve(await realpath(dirname(address)), basename(address)); }
        catch { canonical = address; }
      }
      if (!this.current(capture)) return;
      this.claim(capture, canonical);
      let read = phase.canonical.get(canonical);
      if (!read) {
        read = this.read(capture, phase, canonical);
        phase.canonical.set(canonical, read);
      }
      const value = await read;
      if (value && this.current(capture)) { phase.files.set(address, value); phase.files.set(canonical, value); }
    }));
    phase.pending = Promise.race([
      Promise.all(jobs).then(() => {}),
      new Promise<void>(done => { timeout = setTimeout(() => { if (this.current(capture)) this.discard(capture.key); done(); }, this.limits.phaseMs); }),
    ]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
    return phase.pending;
  }

  private enqueue(capture: Capture, run: () => Promise<void>): Promise<void> {
    if (this.queue.length >= this.limits.queuedReads || !this.current(capture)) return Promise.resolve();
    return new Promise(done => { this.queue.push({ capture, run, done }); this.pump(); });
  }

  private pump(): void {
    while (this.active < this.limits.concurrentReads && this.queue.length) {
      const job = this.queue.shift()!;
      if (!this.current(job.capture)) { job.done(); continue; }
      this.active++;
      void job.run().catch(() => {}).finally(() => { this.active--; job.done(); this.pump(); });
    }
  }

  private async read(capture: Capture, phase: PhaseReads, address: string): Promise<CapturedText | undefined> {
    if (this.reserved + this.retained + this.limits.fileBytes > this.limits.totalBytes) return undefined;
    this.reserved += this.limits.fileBytes;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(address, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!this.current(capture) || !stat.isFile() || stat.size > this.limits.fileBytes) return undefined;
      const inode = `inode:${stat.dev}:${stat.ino}`;
      this.claim(capture, inode);
      const shared = phase.canonical.get(inode);
      if (shared) return await shared;
      phase.canonical.set(inode, phase.canonical.get(address)!);
      const buffer = Buffer.allocUnsafe(stat.size + 1);
      let length = 0;
      while (length < buffer.length && this.current(capture)) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (!this.current(capture) || length > stat.size || buffer.subarray(0, length).includes(0)) return undefined;
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
      if (!this.current(capture)) return undefined;
      phase.bytes += length;
      this.retained += length;
      return { text, bytes: length };
    } catch { return undefined; }
    finally { this.reserved -= this.limits.fileBytes; await file?.close().catch(() => {}); }
  }
}
