/**
 * Sidecar configuration. Every value is environment-driven so the same image
 * runs on Render, Fly.io, Railway or a VPS without a rebuild.
 */

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

  return {
    port: numeric("PORT", 8080),
    secret: required("MEDIA_DOWNLOADER_SECRET"),
    allowedOrigins: origins.length > 0 ? origins : ["http://localhost:3000"],
    workDir: process.env.MEDIA_DOWNLOADER_WORKDIR?.trim() || "/tmp/studio-print-downloads",
    ytdlpBin: process.env.MEDIA_DOWNLOADER_YTDLP?.trim() || "yt-dlp",
    ffmpegBin: process.env.MEDIA_DOWNLOADER_FFMPEG?.trim() || "ffmpeg",
    // `RUNTIME[:PATH]`. A bare path is silently ignored by yt-dlp.
    jsRuntime: process.env.MEDIA_DOWNLOADER_JS_RUNTIME?.trim() || null,
    cookiesFile: process.env.MEDIA_DOWNLOADER_COOKIES?.trim() || null,
    maxConcurrentJobs: numeric("MEDIA_DOWNLOADER_MAX_JOBS", 3),
    maxTrackedJobs: numeric("MEDIA_DOWNLOADER_MAX_TRACKED_JOBS", 24),
    maxSessions: numeric("MEDIA_DOWNLOADER_MAX_SESSIONS", 500),
    maxDiskBytes: numeric("MEDIA_DOWNLOADER_MAX_DISK_BYTES", 3 * 1024 * 1024 * 1024),
    breakerFailureThreshold: numeric("MEDIA_DOWNLOADER_BREAKER_THRESHOLD", 5),
    breakerCooldownMs: numeric("MEDIA_DOWNLOADER_BREAKER_COOLDOWN_MS", 120_000),
    jobTimeoutMs: numeric("MEDIA_DOWNLOADER_JOB_TIMEOUT_MS", 20 * 60 * 1000),
  };
}