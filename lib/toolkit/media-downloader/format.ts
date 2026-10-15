/**
 * Display formatters shared by the preview card and the progress bar.
 * Pure functions so both can be unit tested and reused server-side when
 * rendering a filename.
 */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

/**
 * Filename-safe stem. yt-dlp templates must use the video id, not the title —
 * titles carry `/`, emoji, RTL marks and overrun filesystem limits — but users
 * still want a recognisable name, so we sanitise here on the way out.
 */
export function safeFilename(title: string, extension: string): string {
  const stem = title
    .normalize("NFKC")
    // C0/C1 control characters.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    // Bidi overrides/isolates and zero-width joiners. Without this, a title
    // like "video<RTL>gpj.exe" renders as "video.exe" on Windows — a real
    // spoofing vector, since we set Content-Disposition ourselves.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    // Path separators and characters reserved on Windows.
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, "");

  const fallback = "studio-print-download";
  return `${stem || fallback}.${extension}`;
}
