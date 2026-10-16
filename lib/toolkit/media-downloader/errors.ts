/**
 * Map yt-dlp failures onto the small set of codes the UI knows how to explain.
 *
 * The user-facing promise is "clear error states", so this is deliberately
 * opinionated: every branch ends in a message a non-technical person can act
 * on, plus an optional hint that says what to do next.
 */

import type { DownloaderErrorCode } from "./types";

export type MappedError = {
  readonly code: DownloaderErrorCode;
  readonly message: string;
  readonly hint?: string;
};

/**
 * Match on yt-dlp's stderr. Order matters — the first hit wins, so the more
 * specific patterns must come before the generic ones.
 */
const PATTERNS: readonly { readonly test: RegExp; readonly error: MappedError }[] = [
  {
    test: /private video|this video is private/i,
    error: {
      code: "private_video",
      message: "This video is private.",
      hint: "Only the owner can open it. Ask them to change the visibility to Unlisted or Public.",
    },
  },
  {
    test: /members[- ]only|join this channel|subscription/i,
    error: {
      code: "members_only",
      message: "This video is for channel members only.",
      hint: "Members-only content is not downloadable.",
    },
  },
  {
    // "This post may not be comfortable for some audiences" — the "be" is
// optional in the phrasing yt-dlp actually emits.
test: /age[- ]restricted|confirm your age|not be? comfortable for some audiences/i,
    error: {
      code: "age_restricted",
      message: "This video is age-restricted.",
      hint: "Age-gated content is not downloaded. Try a different link.",
    },
  },
  {
    test: /not available in your country|available in your country|blocked it in your country|geo[- ]?restrict|not available from your location/i,
    error: {
      code: "region_locked",
      message: "This video is not available from our region.",
      hint: "Region-locked content cannot be downloaded here.",
    },
  },
  {
    test: /is live|live event will begin|premieres in/i,
    error: {
      code: "live_stream",
      message: "This is a live stream, so it cannot be downloaded yet.",
      hint: "Come back after the stream has ended and try again.",
    },
  },
  {
    test: /login required|use --cookies|cookies-from-browser|locked behind the login|account.*cookies|login to confirm|sign in to confirm/i,
    error: {
      code: "needs_auth",
      message: "This platform needs a signed-in session we cannot provide.",
      hint: "Instagram, TikTok and X often block anonymous downloads. Public videos usually work.",
    },
  },
  {
    test: /video unavailable|has been removed|no longer available|account associated/i,
    error: {
      code: "unavailable",
      message: "This video is no longer available.",
      hint: "It may have been deleted or made private by its owner.",
    },
  },
  {
    test: /unsupported url|no suitable extractor/i,
    error: {
      code: "unsupported_platform",
      message: "We could not read a media file from that link.",
      hint: "Check that it points to a video post, not a profile or a channel page.",
    },
  },
  {
    test: /requested format is not available|requested format not available/i,
    error: {
      code: "bad_format",
      // Also fires when a post carries no media at all, so the copy must not
      // send the user off to retry a quality that was never the problem.
      message: "We could not find a video or audio track to download in that link.",
      hint: "Photo and text posts have nothing to download. Try a link to a video post.",
    },
  },
  {
    test: /file is bigger than max-filesize|match filter/i,
    error: {
      code: "too_large",
      message: "This file is larger than the download limit.",
      hint: "Choose a lower quality or an audio-only option.",
    },
  },
  {
    test: /429|too many requests|rate[- ]limit/i,
    error: {
      code: "rate_limited",
      message: "This platform is rate-limiting us right now.",
      hint: "Wait a few minutes and try again.",
    },
  },
  {
    // Our own backpressure, not the platform's doing. Kept distinct so the UI
    // and monitoring can tell "we are full" from "they are blocking us".
    test: /at capacity|busy right now|temporarily refusing/i,
    error: {
      code: "service_busy",
      message: "The download service is busy right now.",
      hint: "We are handling a lot of requests. Try again in a minute.",
    },
  },
  {
    test: /\b403\b|forbidden/i,
    error: {
      code: "unavailable",
      message: "The platform refused the request.",
      hint: "This usually means the content is restricted or the link has expired.",
    },
  },
  {
    test: /timed out|timeout/i,
    error: {
      code: "timed_out",
      message: "The platform took too long to respond.",
      hint: "This is usually temporary. Try again in a moment.",
    },
  },
] as const;

/** Extract the most informative line out of yt-dlp's noisy stderr. */
function pickSignal(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const errorLine = lines.find((line) => /^ERROR:/.test(line));
  if (errorLine) return errorLine;

  const warning = lines.filter((line) => /^WARNING:/.test(line)).slice(-2).join(" ");
  return warning || lines.slice(-2).join(" ") || "";
}

export function mapYtdlpError(stderr: string, fallback?: Partial<MappedError>): MappedError {
  const signal = pickSignal(stderr);

  for (const { test, error } of PATTERNS) {
    if (test.test(signal)) return error;
  }

  return {
    code: fallback?.code ?? "unknown",
    message: fallback?.message ?? "We could not process that link.",
    hint: fallback?.hint ?? "Try another link, or a different platform.",
  };
}

/** Error for a failure that happened on our side, not on the platform's. */
export function backendUnavailable(detail?: string): MappedError {
  return {
    code: "backend_unavailable",
    message: "The download service is not responding right now.",
    hint: detail ?? "This is a temporary problem on our side. Try again in a minute.",
  };
}