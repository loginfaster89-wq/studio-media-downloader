/**
 * Sidecar HTTP server.
 *
 * Deliberately built on `node:http` with zero runtime dependencies. Express
 * would add ~70 transitive packages to do routing we need four routes for, and
 * this service sits on the public internet next to a yt-dlp binary — every
 * package is attack surface we do not need.
 *
 * Endpoints
 *   GET  /health                      liveness (shared-secret header)
 *   POST /resolve                     Worker -> metadata + quality list (shared-secret header)
 *   POST /session/:id/start           browser -> begin a download (signed)
 *   GET  /session/:id/events?job=     browser -> SSE progress (signed)
 *   GET  /session/:id/file?job=       browser -> the bytes (signed)
 *
 * Security model: `/resolve` and `/health` require the shared secret and are
 * only ever called by the Worker. Session routes require an HMAC signature the
 * Worker minted, so a leaked URL expires on its own and cannot be replayed
 * against another session.
 */

import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { mapYtdlpError } from "../../../lib/toolkit/media-downloader/errors";
import { verifySession } from "../../../lib/toolkit/media-downloader/session-token";
import type { ProgressEvent, QualityOption } from "../../../lib/toolkit/media-downloader/types";
import { guardMediaUrl } from "../../../lib/toolkit/media-downloader/url-guard";
import type { Config } from "./config";
import { findOutputFile, JobStore, type Job, type Session } from "./job-store";
import { PlatformBreakers } from "./platform-breaker";
import { expectedFilename, resolveMetadata, startDownload } from "./ytdlp";

/** Cap on request bodies. Our largest legit body is a ~40 char URL. */
const MAX_BODY_BYTES = 8 * 1024;

/** Cap concurrent SSE streams per job — each one is a socket plus a timer. */
const MAX_STREAMS_PER_JOB = 4;

/** SSE heartbeat, so proxies do not close an idle stream mid-download. */
const HEARTBEAT_MS = 15_000;

/* ------------------------------------------------------------------ helpers */

async function readJson<T>(request: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }

  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return null;
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

/**
 * CORS restricted to configured origins.
 *
 * EventSource cannot send custom headers, which is why the HMAC rides in the
 * query string. This allow-list is what stops an arbitrary page from opening a
 * stream with a leaked URL.
 */
function applyCors(request: IncomingMessage, response: ServerResponse, config: Config): void {
  const origin = request.headers.origin;
  if (!origin || !config.allowedOrigins.includes(origin.replace(/\/+$/, ""))) return;

  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // So the browser can read these back from the file response.
  response.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hasSecret(request: IncomingMessage, config: Config): boolean {
  const header = request.headers["x-downloader-secret"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && constantTimeEquals(value, config.secret);
}

/**
 * RFC 6266 disposition. The quoted ASCII form covers old browsers, the
 * `filename*` form carries the real UTF-8 title.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function contentTypeFor(path: string): string {
  switch (path.split(".").pop()?.toLowerCase()) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "m4a":
      return "audio/mp4";
    case "mp3":
      return "audio/mpeg";
    case "opus":
      return "audio/opus";
    case "wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

/* -------------------------------------------------------------------- server */

export function createServerFor(config: Config, store: JobStore, breakers = new PlatformBreakers()): Server {
  return createServer((request, response) => {
    void route(request, response, config, store, breakers).catch((error: unknown) => {
      console.error("[media-downloader]", error instanceof Error ? error.message : error);
      if (response.headersSent) response.end();
      else sendJson(response, 500, { ok: false, message: "internal error" });
    });
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  config: Config,
  store: JobStore,
  breakers: PlatformBreakers,
): Promise<void> {
  applyCors(request, response, config);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const segments = url.pathname.split("/").filter(Boolean);

  /**
   * Liveness for the platform probe. Unauthenticated by necessity: Render and
   * most orchestrators issue a plain GET and cannot send our secret header.
   * `/health` (with per-platform detail) stays behind the secret.
   */
  if (url.pathname === "/livez") {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/health") {
    if (!hasSecret(request, config)) return sendJson(response, 401, { ok: false, message: "unauthorised" });
    return sendJson(response, 200, {
      ok: true,
      // Deliberately no workDir: it is the container's filesystem layout, and
      // anything holding the secret should not get a free recon + readiness
      // oracle from one GET. Detail goes to the logs instead.
      ...store.stats(),
      capacity: config.maxConcurrentJobs,
      // Per-platform health is the only useful signal here: a generic "process
      // is up" ping stays green while YouTube is refusing every request.
      platforms: breakers.allHealth(),
    });
  }

  if (url.pathname === "/resolve" && request.method === "POST") {
    return handleResolve(request, response, config, store, breakers);
  }

  /*
   * Image relay.
   *
   * Instagram's CDN answers 403 to Cloudflare's egress ranges, while this service
   * — which just resolved the post from a normal datacenter IP — is served the
   * file. So the Worker asks us for the bytes and hands them to the browser
   * under its own attachment headers.
   */
  if (url.pathname === "/image" && request.method === "GET") {
    if (!hasSecret(request, config)) {
      return sendJson(response, 401, { ok: false, message: "unauthorised" });
    }
    const raw = url.searchParams.get("url");
    let target: URL | null = null;
    try {
      target = raw ? new URL(raw) : null;
    } catch {
      target = null;
    }
    if (!target || target.protocol !== "https:" || !IMAGE_HOSTS.some((rule) => rule.test(target.hostname))) {
      return sendJson(response, 400, { ok: false, message: "that host is not allowed" });
    }
    await handleImage(target, response);
    return;
  }

  if (segments[0] === "session" && segments[1] && segments[2]) {
    const sessionId = segments[1];
    const action = segments[2];

    const verdict = await verifySession(
      sessionId,
      Number(url.searchParams.get("exp")),
      url.searchParams.get("sig") ?? "",
      config.secret,
    );
    if (!verdict.ok) {
      return sendJson(
        response,
        verdict.reason === "expired" ? 410 : 403,
        { ok: false, message: verdict.reason === "expired" ? "session expired" : "invalid signature" },
      );
    }

    const session = store.getSession(sessionId);
    if (!session) return sendJson(response, 404, { ok: false, message: "session not found" });

    if (action === "start" && request.method === "POST") {
      return handleStart(request, response, url, session, config, store);
    }
    if (action === "events" && request.method === "GET") {
      return handleEvents(response, url, session, store, config);
    }
    if (action === "file" && request.method === "GET") {
      return handleFile(response, url, session, store);
    }
  }

  sendJson(response, 404, { ok: false, message: "not found" });
}

/* ------------------------------------------------------------------ resolve */

/**
 * Hosts the image relay may fetch. Same list the Worker enforces; kept here too
 * because this service is directly reachable and must not trust its caller.
 */
const IMAGE_HOSTS = [/(^|\.)cdninstagram\.com$/i, /(^|\.)fbcdn\.net$/i];

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/**
 * Fetch one signed CDN image and stream it back.
 *
 * Read fully into a buffer first: these are single photos (tens to a few hundred
 * KB), and a bounded read is simpler than plumbing a web stream through node's
 * http response, which is what the rest of this file already does with files.
 */
async function handleImage(target: URL, response: ServerResponse): Promise<void> {
  try {
    const upstream = await fetch(target, {
      redirect: "follow",
      headers: {
        accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        "user-agent": BROWSER_UA,
        referer: "https://www.instagram.com/",
      },
    });
    if (!upstream.ok) {
      sendJson(response, 502, { ok: false, message: `the source refused the image (${upstream.status})` });
      return;
    }
    const type = ((upstream.headers.get("content-type") ?? "image/jpeg").split(";")[0] ?? "image/jpeg").trim();
    if (!type.startsWith("image/")) {
      sendJson(response, 502, { ok: false, message: "the source did not return an image" });
      return;
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(200, {
      "content-type": type,
      "content-length": String(bytes.length),
      "cache-control": "no-store",
    });
    response.end(bytes);
  } catch (error) {
    sendJson(response, 502, {
      ok: false,
      message: `the image could not be fetched (${String((error as Error)?.message ?? error).slice(0, 60)})`,
    });
  }
}


async function handleResolve(
  request: IncomingMessage,
  response: ServerResponse,
  config: Config,
  store: JobStore,
  breakers: PlatformBreakers,
): Promise<void> {
  if (!hasSecret(request, config)) {
    sendJson(response, 401, { ok: false, message: "unauthorised" });
    return;
  }

  const body = await readJson<{ url?: unknown }>(request);
  if (!body || typeof body.url !== "string") {
    sendJson(response, 400, { ok: false, stderr: "ERROR: missing url" });
    return;
  }

  // Re-validate here as well as in the Worker. The sidecar is directly
  // reachable and must never proxy whatever URL reaches it.
  const guard = guardMediaUrl(body.url);
  if (!guard.ok) {
    sendJson(response, 200, { ok: false, stderr: `ERROR: ${guard.message}` });
    return;
  }

  // Atomic admission: reserve a slot BEFORE the breaker check so two
  // concurrent requests cannot both pass a check-then-act gap.
  const reservation = store.tryReserve();
  if (!reservation.ok) {
    response.setHeader("Retry-After", String(reservation.retryAfterSeconds));
    sendJson(response, 200, {
      ok: false,
      code: "service_busy",
      stderr: "ERROR: the download service is at capacity, try again shortly",
    });
    return;
  }

  try {
    // If this platform is currently refusing us, say so instead of burning a
    // spawn on a request that will fail the same way as the last five.
    const platform = guard.platform.id;
    const gate = breakers.canAttempt(platform);
    if (!gate.ok) {
      response.setHeader("Retry-After", String(gate.retryAfterSeconds));
      sendJson(response, 200, {
        ok: false,
        code: "platform_unavailable",
        stderr: `ERROR: ${platform} is temporarily refusing downloads, retry in ${gate.retryAfterSeconds}s`,
      });
      return;
    }

    const result = await resolveMetadata(config, guard.url.toString());
    if (!result.ok) {
      // Only platform-side failures feed the breaker. A rejected URL is our
      // answer, not evidence the platform is broken.
      if (isPlatformFailure(result.stderr)) breakers.recordFailure(platform, result.stderr);
      else breakers.recordSuccess(platform);
      sendJson(response, 200, result);
      return;
    }

    breakers.recordSuccess(platform);

    const session = store.createSession(guard.url.toString(), result.meta, result.qualities);
    sendJson(response, 200, {
      ok: true,
      meta: result.meta,
      qualities: result.qualities,
      sessionId: session.id,
    });
  } finally {
    reservation.release();
  }
}

/**
 * Distinguish "this link will never work" from "this platform is refusing us".
 *
 * The first is a normal, expected answer. The second is an incident worth
 * tripping a breaker for.
 *
 * Deliberately conservative: yt-dlp prints "403" on stderr for ordinary partial
 * failures too (one DASH rung blocked while others succeed), so a naive
 * `/\b403\b/` let five unlucky requests disable a healthy platform for everyone.
 * We only count a platform fault when *no* qualities came back AND the error
 * looks infrastructural.
 */
function isPlatformFailure(stderr: string): boolean {
  const infrastructural =
    /\b(429|500|502|503|504)\b|too many requests|rate.?limit|redirect_loop|timed out|service unavailable|forbidden\b/i.test(
      stderr,
    );
  return infrastructural;
}

/* -------------------------------------------------------------------- start */

async function handleStart(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  session: Session,
  config: Config,
  store: JobStore,
): Promise<void> {
  // Atomic reservation BEFORE any await, so concurrent /start calls cannot all
  // pass the same check and spawn 50 yt-dlp processes.
  const reservation = store.tryReserve();
  if (!reservation.ok) {
    response.setHeader("Retry-After", String(reservation.retryAfterSeconds));
    sendJson(response, 429, {
      ok: false,
      code: "service_busy",
      message: "The download service is at capacity, try again shortly",
    });
    return;
  }

  let handedOff = false;
  try {
    const body = await readJson<{ qualityId?: unknown }>(request);
    const qualityId = typeof body?.qualityId === "string" ? body.qualityId : "";

    /**
     * Only accept an id we actually offered. A client string must never reach
     * yt-dlp's `-f` flag — it is a format-expression injection vector.
     */
    const quality: QualityOption | undefined = session.qualities.find((option) => option.id === qualityId);
    if (!quality) {
      sendJson(response, 400, {
        ok: false,
        code: "bad_format",
        message: "That quality is not available for this video.",
        hint: "Go back and pick another quality.",
      });
      return;
    }

  const job = store.createJob(session, quality, expectedFilename(session.meta.title, quality.container));
  // The job is now counted by runningCount(), so the reservation is done.
  handedOff = true;
  reservation.release();
  await mkdir(job.dir, { recursive: true });

  const handle = startDownload(config, {
    url: session.url,
    quality,
    outDir: job.dir,
    onProgress: (event) => {
      // Feed the disk budget with real numbers rather than an estimate.
      if (event.downloadedBytes > job.bytesWritten) job.bytesWritten = event.downloadedBytes;
      store.emit(job, event);
    },
  });

  job.kill = handle.kill;

  // Hard wall-clock cap: a wedged process must not hold a slot forever.
  job.timeout = setTimeout(() => {
    job.kill?.();
    finishJob(job, store, {
      status: "error",
      percent: null,
      downloadedBytes: 0,
      totalBytes: null,
      speedBytesPerSec: null,
      etaSeconds: null,
      error: { code: "timed_out", message: "The download took too long and was stopped." },
    });
  }, config.jobTimeoutMs);
  job.timeout.unref?.();

  let stderr = "";
  handle.child.stderr.setEncoding("utf8");
  handle.child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 32 * 1024) stderr += chunk;
  });

  handle.child.on("close", (code) => {
    if (job.status !== "running") return;
    if (code === 0) {
      void finishJobSuccessfully(job, store);
      return;
    }

    const mapped = mapYtdlpError(stderr || `yt-dlp exited with code ${code}`);
    finishJob(job, store, {
      status: "error",
      percent: null,
      downloadedBytes: 0,
      totalBytes: null,
      speedBytesPerSec: null,
      etaSeconds: null,
      /*
       * Carry the hint through. It is the only place the specific reason is
       * spelled out ("we do not remove DRM", "try again in a minute"), and
       * dropping it left the client to invent generic advice that was wrong
       * for every refusal no other quality could fix.
       */
      error: { code: mapped.code, message: mapped.message, hint: mapped.hint },
    });
  });

  // Reuse the verified signature so the child URLs work with EventSource,
  // which cannot send custom headers.
  const signature = url.search;
  const base = `/session/${encodeURIComponent(session.id)}`;
  const jobParam = `job=${encodeURIComponent(job.id)}`;

  sendJson(response, 200, {
    ok: true,
    eventsUrl: `${base}/events${signature}&${jobParam}`,
    fileUrl: `${base}/file${signature}&${jobParam}`,
    filename: job.filename,
  });
  } finally {
    // Release on every exit path except the hand-off above.
    if (!handedOff) reservation.release();
  }
}

function finishJob(job: Job, store: JobStore, event: ProgressEvent): void {
  if (job.timeout) clearTimeout(job.timeout);
  job.status = event.status === "error" ? "error" : job.status;
  job.finishedAt = Date.now();
  if (event.status === "error") job.error = event;
  store.emit(job, event);
}

async function finishJobSuccessfully(job: Job, store: JobStore): Promise<void> {
  const produced = await findOutputFile(job.dir);

  if (!produced) {
    finishJob(job, store, {
      status: "error",
      percent: null,
      downloadedBytes: 0,
      totalBytes: null,
      speedBytesPerSec: null,
      etaSeconds: null,
      error: { code: "unknown", message: "The download finished but produced no file." },
    });
    return;
  }

  const info = await stat(produced);
  // yt-dlp names the file after the video id. Present the friendly title
  // instead, keeping whatever container yt-dlp actually produced.
  const actualContainer = produced.split(".").pop() ?? job.container;

  if (job.timeout) clearTimeout(job.timeout);
  job.filename = expectedFilename(job.filename.replace(/\.[^.]+$/, ""), actualContainer);
  job.status = "done";
  job.finishedAt = Date.now();

  store.emit(job, {
    status: "done",
    percent: 1,
    downloadedBytes: info.size,
    totalBytes: info.size,
    speedBytesPerSec: null,
    etaSeconds: 0,
  });
}

/* ------------------------------------------------------------------- events */

function handleEvents(
  response: ServerResponse,
  url: URL,
  session: Session,
  store: JobStore,
  config: Config,
): void {
  const job = store.getJobForSession(url.searchParams.get("job") ?? "", session.id);
  if (!job) {
    sendJson(response, 404, { ok: false, message: "job not found" });
    return;
  }

  // Cap concurrent streams per job. Each stream is a live socket plus a timer,
  // so an unbounded number is a connection-exhaustion primitive.
  if (job.listeners.size >= MAX_STREAMS_PER_JOB) {
    sendJson(response, 429, { ok: false, message: "too many streams for this job" });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    // Tells nginx not to buffer the stream.
    "X-Accel-Buffering": "no",
  });

  const send = (event: ProgressEvent): void => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // A job that finished before the browser attached still owes it a result.
  if (job.status === "error") {
    send(job.error ?? { status: "error", percent: null, downloadedBytes: 0, totalBytes: null, speedBytesPerSec: null, etaSeconds: null, error: { code: "unknown", message: "The download failed." } });
    response.end();
    return;
  }
  if (job.status === "done") {
    send({ status: "done", percent: 1, downloadedBytes: 0, totalBytes: 0, speedBytesPerSec: null, etaSeconds: 0 });
    response.end();
    return;
  }

  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, HEARTBEAT_MS);

  // Hard ceiling: a stream for a job that never finishes must not live forever.
  const ceiling = setTimeout(() => close(), config.jobTimeoutMs + 60_000);
  heartbeat.unref?.();
  ceiling.unref?.();

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(ceiling);
    unsubscribe();
    if (!response.writableEnded) response.end();
  };

  /**
   * A terminal frame must end the stream. Cleanup used to run only on client
   * disconnect, so every completed download leaked its socket and its 15s
   * heartbeat until the browser gave up — on the busiest path in the service.
   */
  const unsubscribe = store.subscribe(job, (event) => {
    send(event);
    if (event.status === "done" || event.status === "error") close();
  });

  response.on("close", close);
}

/* --------------------------------------------------------------------- file */

async function handleFile(
  response: ServerResponse,
  url: URL,
  session: Session,
  store: JobStore,
): Promise<void> {
  const job = store.getJobForSession(url.searchParams.get("job") ?? "", session.id);

  if (!job || job.status !== "done") {
    sendJson(response, 409, { ok: false, message: "file is not ready" });
    return;
  }

  const path = await findOutputFile(job.dir);
  if (!path) {
    sendJson(response, 410, { ok: false, message: "file expired" });
    await store.release(job);
    return;
  }

  const info = await stat(path);
  const stream = createReadStream(path);

  response.writeHead(200, {
    "Content-Type": contentTypeFor(path),
    "Content-Length": info.size,
    "Content-Disposition": contentDisposition(job.filename),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  stream.pipe(response);

  // The file exists for exactly one download: delete once the bytes are on
  // the wire, whether the client completed or dropped.
  await new Promise<void>((resolve) => {
    response.on("finish", () => resolve());
    response.on("close", () => resolve());
    stream.on("error", () => resolve());
  });

  stream.destroy();
  await store.release(job);
}
