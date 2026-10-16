/**
 * Sidecar configuration. Every value is environment-driven so the same image
 * runs on Render, Fly.io, Railway or a VPS without a rebuild.
 */

import { accessSync, constants, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function numeric(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Point yt-dlp at a *writable* copy of the cookie jar, outside job scratch.
 *
 * yt-dlp rewrites the jar at the path given to `--cookies` when it exits, so a
 * read-only mount fails the whole run at close time with
 * `OSError: [Errno 30] Read-only file system` — after the download already
 * succeeded. That reads as a total outage rather than a cookie problem, and it
 * takes down platforms that never needed cookies at all.
 *
 * The copy must also live OUTSIDE MEDIA_DOWNLOADER_WORKDIR. That path is job
 * scratch space and JobStore.init() purges every entry in it on boot, so a jar
 * written there is destroyed milliseconds after creation: the service then runs
 * cookie-less while its own boot line claims a jar is loaded. Confirmed live.
 *
 * Returns null rather than any path yt-dlp cannot write, so a bad cookie
 * configuration degrades to "no cookies" instead of "no service".
 */
const COOKIE_DIR = process.env.MEDIA_DOWNLOADER_COOKIE_DIR?.trim() || "/tmp/studio-print-cookies";

function materializeCookies(source: string | null): string | null {
  if (!source) return null;

  try {
    accessSync(source, constants.R_OK);
  } catch {
    console.warn(
      `[media-downloader] MEDIA_DOWNLOADER_COOKIES "${source}" is not readable. Continuing without cookies.`,
    );
    return null;
  }

  const destination = join(COOKIE_DIR, "cookies.txt");
  try {
    mkdirSync(COOKIE_DIR, { recursive: true });
    copyFileSync(source, destination);
    return destination;
  } catch (error) {
    console.warn(
      `[media-downloader] Could not copy the cookie jar to "${destination}" (${String(error)}). Continuing without cookies.`,
    );
    return null;
  }
}

export type Config = {
  readonly port: number;
  readonly secret: string;
  /** Comma-separated list of origins allowed to call the session endpoints. */
  readonly allowedOrigins: readonly string[];
  /** Scratch space for jobs. Must exist and be writable. */
  readonly workDir: string;
  /** yt-dlp executable (absolute path or on PATH). */
  readonly ytdlpBin: string;
  /** ffmpeg executable. Required for merging DASH audio+video. */
  readonly ffmpegBin: string;
  /**
   * Value for yt-dlp's `--js-runtimes`, in `RUNTIME[:PATH]` form.
   *
   * This must NOT be a bare path. Verified against yt-dlp 2026.07.04:
   * `--js-runtimes /usr/local/bin/deno` is rejected with
   * "Ignoring unsupported JavaScript runtime(s)" and YouTube then silently
   * loses formats. The correct form is `deno:/usr/local/bin/deno`, or just
   * `deno` to take it from PATH.
   */
  readonly jsRuntime: string | null;
  /**
   * Extra `--extractor-args` passed straight to yt-dlp, in yt-dlp's own
   * `site:key=value` syntax.
   *
   * A production knob, not a feature: sites retire player clients without
   * warning and the fix is usually a different `youtube:player_client=...`.
   * Without this, reacting to that means a code change and a rebuild.
   */
  readonly extractorArgs: string | null;
  /**
   * Browser to impersonate for yt-dlp's `--impersonate` flag.
   *
   * Empty means off. When set it must be a target curl_cffi actually
   * ships (chrome, safari, edge, ...) or yt-dlp aborts the whole run.
   */
  readonly impersonate: string | null;
  /** Netscape cookie jar for platforms that need it. Optional. */
  readonly cookiesFile: string | null;
  /** Max simultaneous yt-dlp processes. Protects a small container. */
  readonly maxConcurrentJobs: number;
  /** Max jobs retained in memory at once (running + finished, undelivered). */
  readonly maxTrackedJobs: number;
  /** Max sessions held in memory. Bounds memory under resolve flooding. */
  readonly maxSessions: number;
  /** Disk budget for job scratch space. Admission is refused above this. */
  readonly maxDiskBytes: number;
  /** Consecutive platform failures before the circuit breaker trips. */
  readonly breakerFailureThreshold: number;
  /** How long a tripped platform stays open before a probe. */
  readonly breakerCooldownMs: number;
  /** Hard wall-clock cap for a single download. */
  readonly jobTimeoutMs: number;
};

export function loadConfig(): Config {
  const origins = (process.env.MEDIA_DOWNLOADER_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  const workDir = process.env.MEDIA_DOWNLOADER_WORKDIR?.trim() || "/tmp/studio-print-downloads";

  return {
    port: numeric("PORT", 8080),
    secret: required("MEDIA_DOWNLOADER_SECRET"),
    allowedOrigins: origins.length > 0 ? origins : ["http://localhost:3000"],
    workDir,
    ytdlpBin: process.env.MEDIA_DOWNLOADER_YTDLP?.trim() || "yt-dlp",
    ffmpegBin: process.env.MEDIA_DOWNLOADER_FFMPEG?.trim() || "ffmpeg",
    // `RUNTIME[:PATH]`. A bare path is silently ignored by yt-dlp.
    jsRuntime: process.env.MEDIA_DOWNLOADER_JS_RUNTIME?.trim() || null,
    extractorArgs: process.env.MEDIA_DOWNLOADER_YTDLP_EXTRACTOR_ARGS?.trim() || null,
    impersonate: process.env.MEDIA_DOWNLOADER_YTDLP_IMPERSONATE?.trim() || null,
    // Deliberately not the mounted path: secret-file mounts are read-only and
    // yt-dlp writes the jar back on exit. See materializeCookies.
    cookiesFile: materializeCookies(process.env.MEDIA_DOWNLOADER_COOKIES?.trim() || null),
    maxConcurrentJobs: numeric("MEDIA_DOWNLOADER_MAX_JOBS", 3),
    maxTrackedJobs: numeric("MEDIA_DOWNLOADER_MAX_TRACKED_JOBS", 24),
    maxSessions: numeric("MEDIA_DOWNLOADER_MAX_SESSIONS", 500),
    maxDiskBytes: numeric("MEDIA_DOWNLOADER_MAX_DISK_BYTES", 3 * 1024 * 1024 * 1024),
    breakerFailureThreshold: numeric("MEDIA_DOWNLOADER_BREAKER_THRESHOLD", 5),
    breakerCooldownMs: numeric("MEDIA_DOWNLOADER_BREAKER_COOLDOWN_MS", 120_000),
    jobTimeoutMs: numeric("MEDIA_DOWNLOADER_JOB_TIMEOUT_MS", 20 * 60 * 1000),
  };
}