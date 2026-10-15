/**
 * Map yt-dlp's raw `formats[]` array onto the small, curated quality menu the
 * UI shows.
 *
 * The raw list has ~30 rows for one YouTube video (every DASH video-only rung,
 * every audio bitrate, plus legacy HLS duplicates). Showing it verbatim is
 * noise, so we collapse it to one entry per (height, container) and pair each
 * video rung with the best compatible audio track.
 *
 * Runs in the sidecar, but kept here with the shared types so it is unit
 * testable and so the client and server agree on the contract.
 */

import type { MediaContainer, QualityOption } from "./types";

/** The subset of yt-dlp's format dict we rely on. */
export type YtDlpFormat = {
  format_id?: string;
  ext?: string;
  height?: number | null;
  fps?: number | null;
  vcodec?: string;
  acodec?: string;
  filesize?: number | null;
  filesize_approx?: number | null;
  filesz?: string;
  tbr?: number | null;
  vbr?: number | null;
  abr?: number | null;
  format_note?: string | null;
  protocol?: string;
};

export type YtDlpInfo = {
  formats?: YtDlpFormat[];
  duration?: number | null;
};

/** Video rungs we offer, ascending. Anything above 2160 is not useful here. */
const VIDEO_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240, 144] as const;

const MP4_VIDEO_EXTS = new Set(["mp4", "m4v"]);
const WEBM_VIDEO_EXTS = new Set(["webm"]);

/** `none` is yt-dlp's marker for a stream that carries no such codec. */
function hasVideo(format: YtDlpFormat): boolean {
  return Boolean(format.vcodec) && format.vcodec !== "none" && Number(format.height ?? 0) > 0;
}

function hasAudio(format: YtDlpFormat): boolean {
  return Boolean(format.acodec) && format.acodec !== "none" && (format.abr ?? 0) > 0;
}

/**
 * Byte size: prefer the exact value, fall back to the estimate.
 * Returns undefined when yt-dlp genuinely does not know (live, some HLS).
 */
function sizeBytes(format: YtDlpFormat): number | undefined {
  if (typeof format.filesize === "number" && format.filesize > 0) return format.filesize;
  if (typeof format.filesize_approx === "number" && format.filesize_approx > 0) return format.filesize_approx;
  return undefined;
}

/**
 * Pick the best audio-only stream.
 *
 * Container beats bitrate here on purpose. An m4a/AAC source is a pure remux —
 * instant, lossless, and playable on every phone and desktop player — whereas
 * the higher-bitrate Opus/WebM alternative would have to be transcoded to
 * reach the same container, costing the user time for no gain they can hear.
 * Within one container, bitrate decides.
 */
export function pickBestAudio(formats: readonly YtDlpFormat[]): YtDlpFormat | null {
  const candidates = formats.filter(hasAudio);
  if (candidates.length === 0) return null;

  const score = (format: YtDlpFormat): number => {
    const bitrate = format.abr ?? 0;
    // Comfortably exceeds any real bitrate gap (160 vs 128 => 32).
    return (format.ext === "m4a" ? 1000 : 0) + bitrate;
  };

  return candidates.reduce((best, current) => (score(current) > score(best) ? current : best));
}

/** Group video-only streams by height, keeping the best bitrate per container. */
function bestVideoPerHeight(
  formats: readonly YtDlpFormat[],
): Map<number, { mp4?: YtDlpFormat; webm?: YtDlpFormat }> {
  const byHeight = new Map<number, { mp4?: YtDlpFormat; webm?: YtDlpFormat }>();

  for (const format of formats) {
    if (!hasVideo(format)) continue;
    const height = Number(format.height);
    if (!Number.isFinite(height)) continue;

    const bucket = byHeight.get(height) ?? {};
    const ext = format.ext ?? "";
    const slot = MP4_VIDEO_EXTS.has(ext) ? "mp4" : WEBM_VIDEO_EXTS.has(ext) ? "webm" : null;
    if (!slot) continue;

    const incumbent = bucket[slot];
    if (!incumbent || (format.vbr ?? 0) > (incumbent.vbr ?? 0)) {
      bucket[slot] = format;
    }
    byHeight.set(height, bucket);
  }

  return byHeight;
}

/**
 * Build the quality menu.
 *
 * @param info       yt-dlp's `--dump-json` payload for a single entry.
 * @param maxBytes   Hard per-download byte cap. Options that can only exceed it
 *                   are dropped; options with an unknown size are kept but
 *                   flagged, and the server refuses them at download time.
 */
export function buildQualityOptions(
  info: YtDlpInfo,
  maxBytes: number,
): readonly QualityOption[] {
  const formats = info.formats ?? [];
  if (formats.length === 0) return [];

  const bestAudio = pickBestAudio(formats);
  const audioId = bestAudio?.format_id;
  const audioSize = bestAudio ? sizeBytes(bestAudio) : undefined;

  const options: QualityOption[] = [];

  /* ---------- Audio-only ----------
   * The option id is `<formatId>:<targetContainer>`. The sidecar compares the
   * target against the source extension: equal means a pure remux (fast, no
   * quality loss), different means an ffmpeg re-encode. We only advertise a
   * target the source can actually produce losslessly, plus MP3 for the common
   * "give me a playable file" case. */
  if (bestAudio && audioId) {
    const sourceExt = bestAudio.ext ?? "m4a";
    const bitrate = bestAudio.abr ?? bestAudio.tbr;
    const roundedBitrate = bitrate ? Math.round(bitrate) : undefined;

    const targets: readonly MediaContainer[] =
      sourceExt === "mp3" ? ["mp3"] : sourceExt === "m4a" ? ["m4a"] : ["m4a", "mp3"];

    for (const container of targets) {
      // Re-encoding inflates the output; we cannot know the size up front, so
      // flag it unknown rather than quoting the source size (which would lie).
      const isRemux = container === sourceExt;
      options.push({
        id: `${audioId}:${container}`,
        label: [
          "Audio only",
          container.toUpperCase(),
          roundedBitrate ? `${roundedBitrate} kbps` : undefined,
          isRemux ? undefined : "converted",
        ]
          .filter(Boolean)
          .join(" · "),
        kind: "audio",
        container,
        bitrateKbps: roundedBitrate,
        filesizeBytes: isRemux ? audioSize : undefined,
        filesizeUnknown: !isRemux || audioSize === undefined,
      });
    }
  }

  /* ---------- Video ---------- */
  const byHeight = bestVideoPerHeight(formats);

  for (const height of VIDEO_HEIGHTS) {
    const bucket = byHeight.get(height);
    if (!bucket) continue;

    // MP4 first — it is the safest default on phones and desktop players.
    for (const container of ["mp4", "webm"] as const) {
      const video = bucket[container];
      if (!video?.format_id) continue;

      const videoSize = sizeBytes(video);
      // Only offer the combined stream when we could actually mux it.
      const combinedSize = videoSize !== undefined && audioSize !== undefined ? videoSize + audioSize : undefined;

      if (combinedSize !== undefined && combinedSize > maxBytes) continue;

      const ext = container === "mp4" ? "mp4" : "webm";
      const label = [
        `${height}p`,
        ext.toUpperCase(),
        `${Math.round(video.vbr ?? video.tbr ?? 0)} kbps`,
      ].join(" · ");

      options.push({
        id: audioId ? `${video.format_id}+${audioId}` : String(video.format_id),
        label,
        kind: "video",
        container: ext as MediaContainer,
        height,
        bitrateKbps: video.vbr ? Math.round(video.vbr) : video.tbr ? Math.round(video.tbr) : undefined,
        filesizeBytes: combinedSize,
        filesizeUnknown: combinedSize === undefined,
      });
    }
  }

  options.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "video" ? -1 : 1;
    if (a.height !== b.height) return (b.height ?? 0) - (a.height ?? 0);
    return (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0);
  });

  return options;
}

/**
 * The quality the UI pre-selects.
 *
 * Deliberately **1080p, not the maximum**. Verified against real yt-dlp output
 * for "Big Buck Bunny 60fps 4K": the highest option was 2160p at 709 MB, which
 * is a terrible first experience for someone who pasted a link without asking
 * for it. 1080p is the category default (Cobalt also defaults to 1080) and is
 * what people actually want from a share link.
 *
 * Falls back sensibly: best at or below 1080p, else the smallest above it,
 * else audio-only when the source has no video.
 */
export const DEFAULT_TARGET_HEIGHT = 1080;

export function defaultQuality(options: readonly QualityOption[]): QualityOption | null {
  if (options.length === 0) return null;

  const video = options.filter((option) => option.kind === "video");

  if (video.length === 0) return options[0] ?? null;

  const atOrBelow = video.filter((option) => (option.height ?? 0) <= DEFAULT_TARGET_HEIGHT);
  if (atOrBelow.length > 0) {
    // Highest resolution at or below the target; MP4 first when tied because it
    // plays on more devices.
    return atOrBelow.reduce((best, current) => {
      if ((current.height ?? 0) !== (best.height ?? 0)) {
        return (current.height ?? 0) > (best.height ?? 0) ? current : best;
      }
      return current.container === "mp4" ? current : best;
    });
  }

  // Source has nothing below 1080p (rare, e.g. 4K-only uploads) — take the
  // smallest option rather than the largest, so the default stays light.
  return video.reduce((best, current) =>
    (current.height ?? 0) < (best.height ?? 0) ? current : best,
  );
}