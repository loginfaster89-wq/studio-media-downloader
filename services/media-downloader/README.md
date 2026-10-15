# Studio Print — media downloader sidecar

A small Node service that owns `yt-dlp` and serves signed download sessions to
the Next.js app. It is the only component that spawns a process or touches
media bytes.

## Why this is a separate service

The Next.js app runs on **Cloudflare Workers**. Workers cannot run this:

| Need | Workers reality |
|---|---|
| Spawn `yt-dlp` | `node:child_process` is a stub; runtime is `workerd` (JS/Wasm only) |
| Python | not available at all |
| Write files | virtual in-memory FS, 128 MB per file, per-request |
| CPU | 30 s default, 5 min max |
| Browser TLS fingerprint | fixed stack, so `--impersonate` cannot work |

So the Worker is a **control plane** (validate the URL, rate limit, mint a
signed session) and this service is the **data plane** (extract, merge, serve).
Media bytes go browser ↔ sidecar directly and never touch the edge.

## Engine: yt-dlp, not youtube-dl

`youtube-dl`'s last release was **2021.12.17** and it is effectively
unmaintained. `yt-dlp` carries ~1,800 extractors, fixes platform breakage
daily, and supports `--impersonate`, `--match-filters` and
`--progress-template` — the last of which is what makes the progress bar real
instead of a timer.

We deliberately did **not** reimplement extraction in JavaScript. Cobalt — the
other serious option — hand-writes 300–650 lines *per platform* and maintains
them forever. That is a rewrite, which the brief explicitly ruled out.

## Running locally

```bash
cd services/media-downloader
export MEDIA_DOWNLOADER_SECRET="dev-secret"
npm install && npm run build && npm start     # listens on :8080

# in the Next.js app
export MEDIA_DOWNLOADER_URL="http://localhost:8080"
export MEDIA_DOWNLOADER_SECRET="dev-secret"
npm run dev
```

`yt-dlp`, `ffmpeg` and a JS runtime (`deno`) must be on `PATH`, or point at
them with `MEDIA_DOWNLOADER_YTDLP` / `_FFMPEG` / `_JS_RUNTIME`.

## Environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MEDIA_DOWNLOADER_SECRET` | **yes** | — | Must match the Next.js worker |
| `MEDIA_DOWNLOADER_ORIGINS` | no | `http://localhost:3000` | Comma-separated CORS allow-list |
| `MEDIA_DOWNLOADER_URL` | on the app | — | Worker-side: base URL of this service |
| `MEDIA_DOWNLOADER_WORKDIR` | no | `/tmp/studio-print-downloads` | Job scratch space |
| `MEDIA_DOWNLOADER_YTDLP` | no | `yt-dlp` | |
| `MEDIA_DOWNLOADER_FFMPEG` | no | `ffmpeg` | Required for DASH merge + audio extract |
| `MEDIA_DOWNLOADER_JS_RUNTIME` | no | none | Set to `deno`. Without it YouTube loses formats |
| `MEDIA_DOWNLOADER_COOKIES` | no | none | Netscape cookie jar |
| `MEDIA_DOWNLOADER_MAX_JOBS` | no | `3` | Concurrent yt-dlp processes |
| `MEDIA_DOWNLOADER_JOB_TIMEOUT_MS` | no | `1200000` | Hard wall-clock cap per download |

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | secret header | Liveness + current job count |
| `POST` | `/resolve` | secret header | `{url}` → metadata, qualities, `sessionId` |
| `POST` | `/session/:id/start` | signed query | `{qualityId}` → `eventsUrl`, `fileUrl` |
| `GET` | `/session/:id/events?job=` | signed query | SSE progress stream |
| `GET` | `/session/:id/file?job=` | signed query | The bytes, `Content-Disposition: attachment` |

`EventSource` cannot send headers, which is why the HMAC signature rides in the
query string on the session routes. `/resolve` and `/health` are only ever
called by the Worker and use a header.

## Safety properties

- **SSRF** — `guardMediaUrl` runs in *both* the Worker and here: http/https
  only, platform allow-list, no credentials, web ports only, and loopback /
  RFC1918 / CGNAT / cloud-metadata / IPv4-mapped-IPv6 addresses blocked. DNS
  rebinding is handled by the sidecar re-checking at fetch time.
- **Format injection** — the client sends a `qualityId`; the sidecar looks it
  up in the list it originally offered. A client string never reaches `-f`.
- **Resource caps** — 1 hour, 1 GB, `--concurrent-fragments 8`, a 20-minute
  wall clock, and a global concurrency limit.
- **Disk** — a file is deleted the moment it finishes streaming. A sweeper
  removes anything uncollected, and the work dir is purged at startup.

## Known operational risk

Datacenter egress IPs (Render, Fly, Railway, VPS) are frequently login-walled by
Instagram, TikTok and X. YouTube and Reddit are generally fine. If those three
matter, front the sidecar with a residential/ISP proxy
(`HTTP_PROXY`/`HTTPS_PROXY`) or accept a higher failure rate. This is a property
of the platforms, not a bug in the code.

## Scaling

State is in-process, so **one replica only**. Going horizontal means a shared
session store (Redis) and either sticky routing or moving sessions to a
stateless signed-URL scheme.

## Licence note

The image installs yt-dlp's **release binary** (ISC/MIT/Unlicense), not the
PyInstaller build, which bundles GPLv3+ code. See
<https://github.com/yt-dlp/yt-dlp#licensing>.