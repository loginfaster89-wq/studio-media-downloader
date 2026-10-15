/**
 * In-memory session + job registry, with a disk sweeper.
 *
 * Storage is deliberately ephemeral. Downloaded media is user data: keeping it
 * around to "help" costs disk and creates a liability. Every job directory is
 * removed when the file is served, and a sweeper removes anything that was
 * never collected.
 *
 * This is a single-process design. Running >1 replica means sticky sessions or
 * a shared store (see README) — do not scale this blindly.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { DOWNLOAD_LIMITS } from "../../../lib/toolkit/media-downloader/limits";
import type { MediaMeta, ProgressEvent, QualityOption } from "../../../lib/toolkit/media-downloader/types";
import type { Config } from "./config";

export type Session = {
  readonly id: string;
  readonly url: string;
  readonly meta: MediaMeta;
  readonly qualities: readonly QualityOption[];
  readonly createdAt: number;
  lastTouchedAt: number;
};

export type Job = {
  readonly id: string;
  readonly sessionId: string;
  readonly dir: string;
  /**
   * Mutable: set from the requested container at creation, then corrected once
   * yt-dlp finishes — the file it actually writes can differ (asking for MP4
   * can yield WebM if that is all the platform offered).
   */
  filename: string;
  readonly container: string;
  readonly listeners: Set<(event: ProgressEvent) => void>;
  readonly startedAt: number;
  status: "running" | "done" | "error";
  /** Set when the job stops, so the sweeper can expire it precisely. */
  finishedAt?: number;
  /** Running byte total, fed from progress frames so the disk budget is real. */
  bytesWritten: number;
  error?: ProgressEvent;
  kill?: () => void;
  timeout?: NodeJS.Timeout;
};

export type CapacityError = {
  readonly ok: false;
  readonly reason: "concurrency" | "tracked" | "disk" | "sessions";
  readonly retryAfterSeconds: number;
};

export class JobStore {
  private readonly sessions = new Map<string, Session>();
  private readonly jobs = new Map<string, Job>();
  /** Slots held by in-flight resolves and by start-handler gaps. */
  private reserved = 0;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly config: Config) {}

  async init(): Promise<void> {
    await mkdir(this.config.workDir, { recursive: true });
    // Start from a clean slate: a container restart should not inherit junk.
    await this.purgeWorkDir();

    // Sweep every 60s. Unref so it never holds the process open.
    this.sweeper = setInterval(() => {
      void this.sweep();
    }, 60_000);
    this.sweeper.unref?.();
  }

  /* ------------------------------------------------------------- sessions */

  createSession(url: string, meta: MediaMeta, qualities: readonly QualityOption[]): Session {
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      url,
      meta,
      qualities,
      createdAt: now,
      lastTouchedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): Session | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.lastTouchedAt = Date.now();
    return session;
  }

  /* ----------------------------------------------------------------- jobs */

  createJob(session: Session, quality: QualityOption, filename: string): Job {
    const dir = join(this.config.workDir, `${session.id}-${randomUUID().slice(0, 8)}`);
    const job: Job = {
      id: randomUUID(),
      sessionId: session.id,
      dir,
      filename,
      container: quality.container,
      listeners: new Set(),
      startedAt: Date.now(),
      status: "running",
      bytesWritten: 0,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  getJob(id: string): Job | null {
    return this.jobs.get(id) ?? null;
  }

  getJobForSession(jobId: string, sessionId: string): Job | null {
    const job = this.jobs.get(jobId);
    if (!job || job.sessionId !== sessionId) return null;
    return job;
  }

  subscribe(job: Job, listener: (event: ProgressEvent) => void): () => void {
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  emit(job: Job, event: ProgressEvent): void {
    for (const listener of job.listeners) listener(event);
  }

  runningCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) if (job.status === "running") count += 1;
    return count;
  }

  /**
   * Atomic admission. Check and reserve in one synchronous step.
   *
   * Two bugs this closes:
   *  1. `/resolve` spawns yt-dlp without ever creating a job, so a capacity
   *     check that only counted jobs always read 0 and admitted everything.
   *  2. Checking then awaiting before registering the job let every request in
   *     flight during the gap pass the same check (TOCTOU).
   *
   * So the reservation is taken here and released explicitly. Callers MUST
   * release in a `finally`, otherwise the slot leaks until restart.
   *
   * The cap counts running jobs *and* outstanding reservations. Counting only
   * reservations let a running download be joined by another, so the effective
   * limit was maxConcurrentJobs + 1.
   */
  tryReserve(): { ok: true; release: () => void } | CapacityError {
    const used = this.runningCount() + this.reserved;
    if (used >= this.config.maxConcurrentJobs) {
      return { ok: false, reason: "concurrency", retryAfterSeconds: 30 };
    }
    if (this.jobs.size >= this.config.maxTrackedJobs) {
      return { ok: false, reason: "tracked", retryAfterSeconds: 60 };
    }
    if (this.diskBytes() >= this.config.maxDiskBytes) {
      // Disk is the real ceiling on a small ephemeral volume. Sweep early and
      // let the caller retry rather than wedging here.
      void this.sweep();
      return { ok: false, reason: "disk", retryAfterSeconds: 45 };
    }
    if (this.sessions.size >= this.config.maxSessions) {
      return { ok: false, reason: "sessions", retryAfterSeconds: 60 };
    }

    this.reserved += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.reserved = Math.max(0, this.reserved - 1);
      },
    };
  }

  /** Convenience wrapper for callers that only want the verdict. */
  hasCapacity(): boolean {
    return this.runningCount() + this.reserved < this.config.maxConcurrentJobs;
  }

  /** Bytes currently held on disk by live jobs. */
  private diskBytes(): number {
    let total = 0;
    for (const job of this.jobs.values()) total += job.bytesWritten;
    return total;
  }

  totalJobs(): number {
    return this.jobs.size;
  }

  totalSessions(): number {
    return this.sessions.size;
  }

  /** Live snapshot for /health and capacity debugging. */
  stats() {
    return {
      running: this.runningCount(),
      reserved: this.reserved,
      tracked: this.jobs.size,
      sessions: this.sessions.size,
      diskBytes: this.diskBytes(),
    };
  }

  /* -------------------------------------------------------------- cleanup */

  /** Delete a job's directory and forget it. Safe to call twice. */
  async release(job: Job): Promise<void> {
    if (job.timeout) clearTimeout(job.timeout);
    job.timeout = undefined;
    job.kill = undefined;
    job.listeners.clear();
    this.jobs.delete(job.id);
    await rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async sweep(): Promise<void> {
    const now = Date.now();

    for (const job of [...this.jobs.values()]) {
      // A running job must not be expired by the retention window: retention
      // is for *finished* files nobody collected. Running jobs are governed by
      // jobTimeoutMs, which is longer. Using retention for both silently
      // killed every download slower than the retention window.
      const anchor = job.status === "running" ? job.startedAt : (job.finishedAt ?? job.startedAt);
      const limit = job.status === "running" ? this.config.jobTimeoutMs + 60_000 : DOWNLOAD_LIMITS.fileRetentionMs;
      if (now - anchor > limit) {
        job.kill?.();
        await this.release(job);
      }
    }

    for (const session of [...this.sessions.values()]) {
      if (now - session.lastTouchedAt > DOWNLOAD_LIMITS.sessionIdleMs) {
        this.sessions.delete(session.id);
      }
    }
  }

  /** Remove everything under the work dir. Used once at startup. */
  private async purgeWorkDir(): Promise<void> {
    const entries = await readdir(this.config.workDir).catch(() => [] as string[]);
    await Promise.all(
      entries.map((entry) => rm(join(this.config.workDir, entry), { recursive: true, force: true })),
    );
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const job of [...this.jobs.values()]) {
      job.kill?.();
      await this.release(job);
    }
  }
}

/** Absolute path of the single file yt-dlp produced in a job directory. */
export async function findOutputFile(dir: string): Promise<string | null> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  // yt-dlp may leave .part files behind on failure; ignore them.
  const files = entries.filter((name) => !name.endsWith(".part") && !name.endsWith(".ytdl"));
  if (files.length === 0) return null;

  let best: { path: string; size: number } | null = null;
  for (const name of files) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    if (!best || info.size > best.size) best = { path, size: info.size };
  }
  return best?.path ?? null;
}