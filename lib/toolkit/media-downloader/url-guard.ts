/**
 * URL guard for the media downloader.
 *
 * Two jobs:
 *   1. Decide whether we support the platform at all (fast, offline check).
 *   2. Make it safe to hand an arbitrary user string to a server that will
 *      fetch it — block SSRF targets, non-web schemes, credentialed URLs and
 *      absurd ports.
 *
 * Kept dependency-free and runtime-neutral so it runs identically in the Worker
 * and in the browser (the browser uses it for instant feedback before a round
 * trip).
 *
 * SCOPE — read this before assuming more is covered. This is a hostname-level
 * allow-list, enforced in both the Worker and the sidecar. It is NOT a
 * post-resolution IP check: nothing here performs DNS, so a DNS-rebinding
 * answer is not caught. The remaining exposure is redirects that an
 * allow-listed host may issue to an internal address, which yt-dlp follows.
 * The real control for that is network-layer egress filtering on the sidecar
 * container (deny RFC1918 / link-local / loopback for the whole process), and
 * that is an operator responsibility, documented in the sidecar README.
 */

import type { DownloaderErrorCode } from "./types";

/** Max accepted URL length. Long enough for any real share link. */
export const MAX_URL_LENGTH = 2048;

export type SupportedPlatform = {
  readonly id: string;
  readonly label: string;
  /** Hostname suffixes, lower-case, no leading dot. */
  readonly hosts: readonly string[];
};

/**
 * The platforms yt-dlp reliably serves for our use case.
 *
 * Deliberately allow-listed rather than "anything yt-dlp parses": the sidecar
 * would happily fetch an arbitrary site, which turns us into an open proxy and
 * an SSRF gadget. An empty unknown-platform match is a hard reject.
 */
export const SUPPORTED_PLATFORMS: readonly SupportedPlatform[] = [
  { id: "youtube", label: "YouTube", hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com", "music.youtube.com"] },
  { id: "instagram", label: "Instagram", hosts: ["instagram.com", "instagr.am"] },
  { id: "twitter", label: "X / Twitter", hosts: ["twitter.com", "x.com", "t.co"] },
  { id: "tiktok", label: "TikTok", hosts: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"] },
  { id: "facebook", label: "Facebook", hosts: ["facebook.com", "fb.watch", "fb.com"] },
  { id: "reddit", label: "Reddit", hosts: ["reddit.com", "redd.it", "v.redd.it"] },
  { id: "soundcloud", label: "SoundCloud", hosts: ["soundcloud.com", "on.soundcloud.com"] },
  { id: "dailymotion", label: "Dailymotion", hosts: ["dailymotion.com", "dai.ly"] },
  { id: "vimeo", label: "Vimeo", hosts: ["vimeo.com", "player.vimeo.com"] },
  { id: "pinterest", label: "Pinterest", hosts: ["pinterest.com", "pin.it", "pinterest.ca", "pinterest.co.uk"] },
  { id: "tumblr", label: "Tumblr", hosts: ["tumblr.com"] },
  { id: "vk", label: "VK", hosts: ["vk.com", "vkvideo.ru"] },
  { id: "bilibili", label: "Bilibili", hosts: ["bilibili.com", "b23.tv"] },
] as const;

export type UrlGuardResult =
  | { readonly ok: true; readonly url: URL; readonly platform: SupportedPlatform }
  | { readonly ok: false; readonly code: DownloaderErrorCode; readonly message: string; readonly hint?: string };

/** Hostnames we refuse regardless of scheme/port tricks. */
const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata.goog",
]);

/**
 * Cloud metadata + loopback + RFC1918 + CGNAT, in IPv4 form.
 * Compared against the parsed host when the URL used a literal IP.
 */
const BLOCKED_IPV4_PATTERNS: readonly RegExp[] = [
  /^127\./, // loopback
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^169\.254\./, // link-local + cloud metadata
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  /^0\./, // this-network
  /^224\./, // multicast
  /^240\./, // reserved
];

const BLOCKED_IPV6_PATTERNS: readonly RegExp[] = [
  /^::1$/, // loopback
  /^fc/i, // unique local fc00::/7
  /^fd/i, // unique local fd00::/8
  /^fe80:/i, // link-local
  /^::ffff:/i, // IPv4-mapped -> re-check as v4 below
];

function hostMatches(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/** Strip the IPv6 brackets URL parsing leaves on us. */
function normaliseHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
}

function isBlockedIp(host: string): boolean {
  if (BLOCKED_IPV4_PATTERNS.some((pattern) => pattern.test(host))) return true;
  return BLOCKED_IPV6_PATTERNS.some((pattern) => pattern.test(host));
}

/**
 * Validate and classify a user-supplied share URL.
 *
 * Accepts a bare host or "youtube.com/watch?v=x" and upgrades it to https,
 * because pasting a schemeless link is the common case on mobile.
 */
export function guardMediaUrl(input: string): UrlGuardResult {
  const raw = input.trim();

  if (!raw) {
    return fail("invalid_url", "Paste a link to continue.", "Supported: YouTube, Instagram, Pinterest, Reddit, Vimeo and more.");
  }
  if (raw.length > MAX_URL_LENGTH) {
    return fail("invalid_url", "That link is too long to process.");
  }
  // Block obvious injection attempts before we do anything clever with parsing.
  if (/[\s<>"'\\]/.test(raw)) {
    return fail("invalid_url", "That link contains characters a web link cannot have.");
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return fail("invalid_url", "That does not look like a valid link.", "Copy the link again from the app and paste it here.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("unsupported_platform", "Only http and https links are supported.");
  }
  if (url.username || url.password) {
    return fail("invalid_url", "Links containing a username or password are not accepted.");
  }

  // Anything other than the web ports is a proxy-abuse vector.
  const port = url.port;
  if (port !== "" && port !== "80" && port !== "443") {
    return fail("unsupported_platform", "That link uses a port we cannot reach.");
  }

  const host = normaliseHost(url.hostname);
  if (!host) {
    return fail("invalid_url", "That link is missing a website address.");
  }
  if (BLOCKED_HOSTS.has(host) || isBlockedIp(host)) {
    return fail("unsupported_platform", "That link points to a private or reserved network and is not supported.");
  }

  // IPv4-mapped IPv6 (::ffff:127.0.0.1) — re-check the embedded v4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (mapped?.[1] && isBlockedIp(mapped[1])) {
    return fail("unsupported_platform", "That link points to a private or reserved network and is not supported.");
  }

  const platform = SUPPORTED_PLATFORMS.find((candidate) =>
    candidate.hosts.some((suffix) => hostMatches(host, suffix)),
  );

  if (!platform) {
    return fail(
      "unsupported_platform",
      "That platform is not supported yet.",
      `We support ${SUPPORTED_PLATFORMS.map((item) => item.label).join(", ")}.`,
    );
  }

  // Normalise to https and drop the fragment (never sent to the server).
  url.protocol = "https:";
  url.hash = "";

  return { ok: true, url, platform };
}

/** Human-facing list for the empty state and the footer note. */
export function supportedPlatformLabels(): readonly string[] {
  return SUPPORTED_PLATFORMS.map((item) => item.label);
}

function fail(
  code: DownloaderErrorCode,
  message: string,
  hint?: string,
): UrlGuardResult {
  return hint ? { ok: false, code, message, hint } : { ok: false, code, message };
}