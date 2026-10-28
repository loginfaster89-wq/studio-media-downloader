/**
 * Download limits, shared by the Worker route and the sidecar.
 *
 * These live in their own module so the sidecar can import them without
 * pulling in `backend.ts`, which is Worker-specific (process.env, edge fetch).
 *
 * The two layers enforce independently on purpose: the Worker refuses early so
 * we never burn a yt-dlp spawn, and the sidecar re-applies them because it is
 * directly reachable and must not trust its caller.
 */
export const DOWNLOAD_LIMITS = {
  /** Reject anything longer than this. Mirrored as `--match-filters`. */
  maxDurationSeconds: 60 * 60,
  /** Reject anything larger. Mirrored as `--max-filesize`. */
  maxFileBytes: 1024 * 1024 * 1024,
  /** A playlist listing beyond this is refused with guidance. */
  maxPlaylistEntries: 50,
  /**
   * How many slides of an image carousel are read. Instagram caps a carousel at
   * 20; the bound exists so a hostile or broken source cannot turn one resolve
   * into an unbounded walk.
   */
  maxCarouselSlides: 20,
  /** Metadata extraction budget. */
  resolveTimeoutMs: 60_000,
  /** How long a finished file is kept before the sweeper deletes it. */
  fileRetentionMs: 10 * 60 * 1000,
  /** How long an idle session survives. */
  sessionIdleMs: 15 * 60 * 1000,
} as const;