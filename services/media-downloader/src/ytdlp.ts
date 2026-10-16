/**
 * The only module that talks to yt-dlp.
 *
 * Everything yt-dlp-specific lives here: argument construction, parsing its
 * `--progress-template` NDJSON, and turning a failed exit into useful stderr.
 * Keeping it in one file means a yt-dlp release that changes its output format
 * breaks exactly one seam.
 *
 * Engine choice: yt-dlp, not youtube-dl. youtube-dl's last release was
 * 2021.12.17 and it is effectively unmaintained; yt-dlp carries ~1864
 * extractors, daily breakage fixes, `--impersonate`, and `--progress-template`.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { DOWNLOAD_LIMITS } from "../../../lib/toolkit/media-downloader/limits";
import {
  buildQualityOptions,
  type YtDlpInfo,
} from "../../../lib/toolkit/media-downloader/format-map";
import { safeFilename } from "../../../lib/toolkit/media-downloader/format";
import type { MediaEntry, MediaMeta, ProgressEvent, QualityOption } from "../../../lib/toolkit/media-downloader/types";
import type { Config } from "./config";

export type ResolveResult =
  | { readonly ok: true; readonly meta: MediaMeta; readonly qualities: readonly QualityOption[] }
  | { readonly ok: false; readonly stderr: string };

/* ------------------------------------------------------------------ metadata */

/**
 * Read metadata and the format list without downloading anything.
 *
 * `-J` simulates by default (no bytes fetched for the media), `--flat-playlist`
 * keeps large playlists cheap, and `--no-playlist` stops a channel URL from
 * expanding into hundreds of entries.
 */
/**
 * Common flags for every invocation.
 *
 * `--remote-components ejs:github` is required for YouTube from 2025 onward.
 * `--js-runtimes` must be `RUNTIME[:PATH]`; a bare path is rejected and the
 * runtime is then silently unavailable. `--match-filters` ANDs with `&` and
 * compares without spaces (`duration<?3600&!is_live`); the space-separated
 * form raises a TypeError inside yt-dlp and aborts the download.
 */
function baseArgs(config: Config): string[] {
  const args = [
    "--no-config",
    "--no-warnings",
    "--retries",
    "5",
    "--fragment-retries",
    "8",
    "--socket-timeout",
    "30",
    "--remote-components",
    "ejs:github",
    "--match-filters",
    `duration<?${DOWNLOAD_LIMITS.maxDurationSeconds}&!is_live`,
    "--max-filesize",
    String(DOWNLOAD_LIMITS.maxFileBytes),
  ];

  if (config.ffmpegBin) args.push("--ffmpeg-location", config.ffmpegBin);
  if (config.cookiesFile) args.push("--cookies", config.cookiesFile);
  if (config.jsRuntime) args.push("--js-runtimes", config.jsRuntime);
  if (config.extractorArgs) args.push("--extractor-args", config.extractorArgs);
  if (config.impersonate) args.push("--impersonate", config.impersonate);

  return args;
}

/** Metadata extraction: simulate only, never fetch media bytes. */
export async function resolveMetadata(config: Config, url: string): Promise<ResolveResult> {
  const args = [
    "--dump-json",
    "--flat-playlist",
    "--no-playlist",
    // `--no-progress` belongs HERE and nowhere else. In yt-dlp it selects
    // QuietMultilinePrinter, whose print_at_line() is a no-op, which silently
    // discards every --progress-template frame. Passing it on the download
    // path killed the entire progress feature.
    "--no-progress",
    ...baseArgs(config),
    url,
  ];

  const run = await execFile(config.ytdlpBin, args, {
    timeoutMs: DOWNLOAD_LIMITS.resolveTimeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });

  if (run.code !== 0 || !run.stdout.trim()) {
    return { ok: false, stderr: run.stderr || `yt-dlp exited with code ${run.code}` };
  }

  // `--dump-json` emits one JSON object per line; a single video emits one.
  const lines = run.stdout.split("\n").filter((line) => line.trim());
  let primary: RawInfo | null = null;
  const entries: MediaEntry[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as RawInfo;
      if (!primary) primary = parsed;
      if (lines.length > 1 && parsed.id) {
        entries.push({
          id: parsed.id,
          title: parsed.title ?? "Untitled",
          durationSeconds: typeof parsed.duration === "number" ? parsed.duration : undefined,
          thumbnailUrl: optionalString(parsed.thumbnail),
        });
      }
    } catch {
      // A malformed line should not sink an otherwise good extraction.
    }
  }

  if (!primary) return { ok: false, stderr: run.stderr || "yt-dlp returned no usable JSON" };

  const isPlaylist = entries.length > 0 || primary._type === "playlist";

  const meta: MediaMeta = {
    id: primary.id ?? "",
    title: primary.title ?? "Untitled",
    uploader: optionalString(primary.uploader),
    durationSeconds: typeof primary.duration === "number" ? primary.duration : undefined,
    thumbnailUrl: optionalString(primary.thumbnail),
    sourceUrl: optionalString(primary.webpage_url) ?? url,
    platform: normalisePlatform(primary, url),
    // A live stream has no stable duration and changes under you; we refuse it.
    isLive: isLiveInfo(primary),
    isPlaylist,
    entries: isPlaylist ? entries.slice(0, DOWNLOAD_LIMITS.maxPlaylistEntries) : undefined,
  };

  // Refuse an over-long video here as well as in the Worker — the sidecar is
  // directly reachable and must not rely on the caller's checks.
  if (meta.durationSeconds && meta.durationSeconds > DOWNLOAD_LIMITS.maxDurationSeconds) {
    return { ok: false, stderr: "ERROR: duration exceeds the 1 hour limit" };
  }
  if (meta.isLive) {
    return { ok: false, stderr: "ERROR: this is a live stream" };
  }

  const qualities = buildQualityOptions(primary, DOWNLOAD_LIMITS.maxFileBytes);
  if (qualities.length === 0) {
    return { ok: false, stderr: run.stderr || `ERROR: requested format is not available${formatCensus(primary)}` };
  }

  return { ok: true, meta, qualities };
}

/** The shape we care about from yt-dlp's JSON. Extra fields are ignored. */
type RawInfo = YtDlpInfo & {
  id?: string;
  title?: string;
  uploader?: string;
  thumbnail?: string;
  extractor_key?: string;
  extractor?: string;
  is_live?: boolean;
  live_status?: string;
  webpage_url?: string;
  _type?: string;
};

/**
 * A compact census of the formats yt-dlp actually returned.
 *
 * Appended to the "no format" error so the log distinguishes an image-only post
 * (no codecs at all) from a source we filtered out — the difference between
 * "there is nothing to download here" and a real defect in the quality picker.
 */
function formatCensus(info: RawInfo): string {
  const formats = info.formats ?? [];
  if (formats.length === 0) return " (the source reported no formats)";
  const sample = formats
    .slice(0, 3)
    .map((f) => `${f.ext ?? "?"} v=${f.vcodec ?? "?"} a=${f.acodec ?? "?"} h=${f.height ?? "?"}`)
    .join("; ");
  return ` (${formats.length} format${formats.length === 1 ? "" : "s"}: ${sample})`;
}

function isLiveInfo(info: RawInfo): boolean {
  return info.is_live === true || info.live_status === "is_live" || info.live_status === "is_upcoming";
}

function normalisePlatform(info: RawInfo, url: string): string {
  // yt-dlp reports extractor keys like "Youtube", "YoutubeTab", "TikTok".
  const key = (info.extractor_key ?? info.extractor ?? "").toLowerCase();
  if (key.startsWith("youtube")) return "youtube";
  if (key) return key.split(":")[0] ?? "unknown";
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "unknown";
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/* ------------------------------------------------------------------ download */

/** A job we can stream progress from and later kill. */
export type JobHandle = {
  // stdin is closed, so this is the by-stdio shape rather than
  // ChildProcessWithoutNullStreams.
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly kill: () => void;
};

/**
 * Progress template. yt-dlp emits one frame per line, which is what makes the
 * progress bar *real* rather than a timer-driven animation.
 *
 * Two non-obvious yt-dlp behaviours, both found by running it:
 *
 * 1. `download:` is a TYPE SELECTOR, not an output prefix. yt-dlp consumes it
 *    and prints only the remainder, so a template of `download:{...}` emits
 *    bare `{...}`. Matching on a `download:` prefix silently discarded 100% of
 *    frames. We therefore mark our own sentinel and match on that.
 *
 * 2. Without a literal default, a null field renders as the bare token `NA`,
 *    producing invalid JSON (`"total":NA`) which then fails to parse — and null
 *    is exactly the unknown-size case the indeterminate bar exists to serve.
 *    Every numeric field carries `|0`; the parser maps 0 back to null.
 */
const PROGRESS_SENTINEL = "@@VD@@";
const PROGRESS_TEMPLATE =
  `download:${PROGRESS_SENTINEL}{"status":"%(progress.status)s","downloaded":%(progress.downloaded_bytes|0)d,` +
  `"total":%(progress.total_bytes|0)d,"estimate":%(progress.total_bytes_estimate|0)d,` +
  `"speed":%(progress.speed|0)d,"eta":%(progress.eta|0)d}`;

export type StartDownloadOptions = {
  readonly url: string;
  readonly quality: QualityOption;
  readonly outDir: string;
  readonly onProgress: (event: ProgressEvent) => void;
};

/**
 * Spawn yt-dlp for one download.
 *
 * Flags worth knowing about:
 *   -f <qualityId>          the exact formats the user picked
 *   -o %(id)s.%(ext)s       NEVER %(title)s — titles contain slashes and emoji
 *   --concurrent-fragments  biggest single speed win for DASH/HLS
 *   --max-filesize          belt-and-braces; unknown-size streams still need
 *                           the duration match-filter above
 */
export function startDownload(config: Config, options: StartDownloadOptions): JobHandle {
  const { url, quality, outDir, onProgress } = options;

  const args = [
    "--newline",
    "--no-part",
    "--no-overwrites",
    "--concurrent-fragments",
    "8",
    "--progress-template",
    PROGRESS_TEMPLATE,
    "--progress-delta",
    "1",
    // Reddit and most DASH sources ship video and audio as separate streams.
    // Without this the user gets a silent file — the #1 complaint in this category.
    "--merge-output-format",
    "mp4",
    ...baseArgs(config),
    "-f",
    quality.id,
    "-o",
    `${outDir}/%(id)s.%(ext)s`,
  ];

  if (quality.container === "m4a" || quality.container === "mp3") {
    // Audio extraction. `-x` runs ffmpeg; m4a from an m4a source is a remux.
    args.push("-x", "--audio-format", quality.container);
  }
  args.push(url);

  const child = spawn(config.ytdlpBin, args, { stdio: ["ignore", "pipe", "pipe"] });

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      // Only our sentinel-tagged frames are progress. Everything else on
      // stdout is yt-dlp's own [info]/[download] logging.
      if (!line.startsWith(PROGRESS_SENTINEL)) continue;
      const event = parseProgress(line.slice(PROGRESS_SENTINEL.length));
      if (event) onProgress(event);
    }
  });

  return {
    child,
    kill: () => {
      if (!child.killed) child.kill("SIGKILL");
    },
  };
}

/** Filename yt-dlp will produce, so the browser gets a correct Content-Disposition. */
export function expectedFilename(title: string, container: string): string {
  return safeFilename(title, container);
}

/** Parse one `download:` line. Returns null when the frame is unusable. */
function parseProgress(raw: string): ProgressEvent | null {
  let parsed: {
    status?: string;
    downloaded?: number;
    total?: number | null;
    estimate?: number | null;
    speed?: number | null;
    eta?: number | null;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed.status !== "downloading" && parsed.status !== "finished") return null;

  // yt-dlp reports null when the size is unknown. Passing that through as null
  // is what makes the UI show an indeterminate bar instead of a fake percent.
  const total = typeof parsed.total === "number" && parsed.total > 0 ? parsed.total
    : typeof parsed.estimate === "number" && parsed.estimate > 0 ? parsed.estimate
    : null;

  const downloaded = typeof parsed.downloaded === "number" ? parsed.downloaded : 0;

  return {
    status: parsed.status === "finished" ? "done" : "downloading",
    percent: total && total > 0 ? Math.min(1, downloaded / total) : null,
    downloadedBytes: downloaded,
    totalBytes: total,
    speedBytesPerSec: typeof parsed.speed === "number" && parsed.speed > 0 ? parsed.speed : null,
    etaSeconds: typeof parsed.eta === "number" && parsed.eta >= 0 ? parsed.eta : null,
  };
}

/* --------------------------------------------------------------------- utils */

type ExecResult = { code: number; stdout: string; stderr: string };

function execFile(
  bin: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBuffer: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      stderr += `\nERROR: operation timed out after ${options.timeoutMs}ms`;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < options.maxBuffer) stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `\nERROR: failed to run ${bin}: ${error.message}`;
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}