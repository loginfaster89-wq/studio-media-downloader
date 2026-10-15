/**
 * Shared contracts for the media downloader.
 *
 * These types describe the wire format between:
 *   browser  <->  Next.js Worker route  <->  yt-dlp sidecar
 *
 * Keep this file dependency-free and runtime-neutral: it is imported by both
 * the Edge/Worker route handlers and the browser client component.
 */

/** Media kind the caller asked for. Controls yt-dlp's format selector. */
export type MediaKind = "video" | "audio";

/** Container we will hand back to the browser. */
export type MediaContainer = "mp4" | "webm" | "mp3" | "m4a";

/** A single selectable quality, derived from yt-dlp's format list. */
export type QualityOption = {
  /** Opaque yt-dlp format selector expression, e.g. "137+140". */
  readonly id: string;
  /** Human label, e.g. "1080p · MP4". */
  readonly label: string;
  readonly kind: MediaKind;
  readonly container: MediaContainer;
  /** Vertical resolution, absent for audio-only. */
  readonly height?: number;
  /** Combined bitrate in kbps when yt-dlp knows it. */
  readonly bitrateKbps?: number;
  /** Estimated bytes when known. */
  readonly filesizeBytes?: number;
  /** True when yt-dlp could not determine the size up front. */
  readonly filesizeUnknown?: boolean;
};

/** Normalised metadata for a single media item. */
export type MediaMeta = {
  readonly id: string;
  readonly title: string;
  readonly uploader?: string;
  readonly durationSeconds?: number;
  readonly thumbnailUrl?: string;
  readonly sourceUrl: string;
  /** Detected platform, e.g. "youtube", "instagram". */
  readonly platform: string;
  readonly isLive: boolean;
  /** True when the URL pointed at a playlist/album/channel dump. */
  readonly isPlaylist: boolean;
  /** Populated only when isPlaylist is true. */
  readonly entries?: readonly MediaEntry[];
};

/** One row of a playlist listing. Kept light — no per-entry extraction. */
export type MediaEntry = {
  readonly id: string;
  readonly title: string;
  readonly durationSeconds?: number;
  readonly thumbnailUrl?: string;
};

/** Successful `/resolve` payload. */
export type ResolveResponse = {
  readonly ok: true;
  readonly meta: MediaMeta;
  readonly qualities: readonly QualityOption[];
  /**
   * Signed, absolute sidecar URL the browser uses for progress + bytes.
   * Expires quickly. Never stored or logged.
   */
  readonly sessionUrl: string;
  /** Epoch ms after which sessionUrl is dead. */
  readonly expiresAt: number;
};

/** Machine-readable failure codes. The UI maps these to copy + a next action. */
export type DownloaderErrorCode =
  | "invalid_url"
  | "unsupported_platform"
  | "private_video"
  | "members_only"
  | "age_restricted"
  | "region_locked"
  | "geo_restricted"
  | "live_stream"
  | "playlist_too_large"
  | "too_long"
  | "too_large"
  | "unavailable"
  | "rate_limited"
  /** Our sidecar is at capacity — distinct from a platform refusing us. */
  | "service_busy"
  /** A platform (e.g. YouTube) is refusing this server right now. */
  | "platform_unavailable"
  | "needs_auth"
  | "timed_out"
  | "backend_unavailable"
  | "bad_format"
  | "unknown";

/** Failed `/resolve` payload. `hint` is an actionable next step for the user. */
export type DownloaderErrorResponse = {
  readonly ok: false;
  readonly code: DownloaderErrorCode;
  readonly message: string;
  readonly hint?: string;
};

/** One progress tick streamed from the sidecar over SSE. */
export type ProgressEvent = {
  readonly status: "downloading" | "processing" | "merging" | "done" | "error";
  /** 0..1. `null` when the total size is unknown. */
  readonly percent: number | null;
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly speedBytesPerSec: number | null;
  readonly etaSeconds: number | null;
  readonly error?: { readonly code: DownloaderErrorCode; readonly message: string };
};

/** Response for `GET /file` — streamed straight from the sidecar. */
export type FileReady = {
  readonly ready: true;
  readonly downloadUrl: string;
  readonly filename: string;
  readonly filesizeBytes: number | null;
  readonly container: MediaContainer;
};