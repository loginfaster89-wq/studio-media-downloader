# yt-dlp sidecar for the Studio Print video downloader.
#
# Pinned to yt-dlp release builds rather than the PyInstaller zipapp: the
# PyInstaller binaries bundle GPLv3+ code, while the release binary is
# ISC/MIT/Unlicense. See https://github.com/yt-dlp/yt-dlp#licensing
#
# ffmpeg is required to merge DASH audio+video and to extract audio-only
# streams. Deno is the JS runtime YouTube's signature challenge requires —
# without it yt-dlp silently drops the `web` player client and you lose
# formats.

FROM node:20-bookworm-slim

ARG YT_DLP_RELEASE=2026.07.04
ARG DENO_VERSION=1.46.3

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl python3 unzip \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp's *stable* is frequently months old and breaks when sites change, which
# is the single most common cause of an outage for a downloader service. The
# release binary (not the GPL PyInstaller build) is used deliberately; see
# https://github.com/yt-dlp/yt-dlp#licensing
RUN curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" \
  && chmod 0755 /usr/local/bin/yt-dlp

# Deno is the JS runtime YouTube's signature challenge requires. Without it
# yt-dlp drops player clients and eventually 403s.
RUN curl -fsSL -o /tmp/deno.zip \
      "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip" \
  && unzip -q /tmp/deno.zip -d /usr/local/bin \
  && rm /tmp/deno.zip \
  && chmod 0755 /usr/local/bin/deno \
  && yt-dlp --version \
  && deno --version

# yt-dlp >= 2025 needs this package alongside a JS runtime or YouTube formats
# silently disappear. Install to the site-packages yt-dlp actually loads.
RUN python3 -m pip install --no-cache-dir --break-system-packages yt-dlp-ejs || \
    echo "yt-dlp-ejs unavailable; YouTube may serve reduced formats"

# curl_cffi backs yt-dlp's --impersonate flag. Several sites refuse a plain
# Python TLS fingerprint outright and return logged-out or empty markup instead
# of video URLs; presenting a browser-like fingerprint is the only fix short of
# an authenticated session.
RUN python3 -m pip install --no-cache-dir --break-system-packages curl_cffi || \
    echo "curl_cffi unavailable; yt-dlp will refuse --impersonate"

WORKDIR /app

COPY services/media-downloader/package.json services/media-downloader/tsconfig.json ./services/media-downloader/
COPY lib/toolkit/media-downloader ./lib/toolkit/media-downloader
COPY services/media-downloader/src ./services/media-downloader/src

# devDependencies only; the service itself has zero runtime dependencies.
RUN cd services/media-downloader \
  && npm install --no-audit --no-fund \
  && npm run build

# Scratch space for jobs. Mount a volume here to survive restarts, but note
# that a clean start is preferable — nothing here should outlive its download.
ENV MEDIA_DOWNLOADER_WORKDIR=/tmp/studio-print-downloads
RUN mkdir -p "$MEDIA_DOWNLOADER_WORKDIR" && chown node:node "$MEDIA_DOWNLOADER_WORKDIR"

ENV NODE_ENV=production
ENV PORT=8080
ENV MEDIA_DOWNLOADER_YTDLP=/usr/local/bin/yt-dlp
ENV MEDIA_DOWNLOADER_FFMPEG=/usr/bin/ffmpeg
# RUNTIME[:PATH] form. A bare path is rejected by yt-dlp and the JS runtime is
# then silently unavailable, which costs YouTube formats. Verified against
# yt-dlp 2026.07.04 + deno 2.9.7.
ENV MEDIA_DOWNLOADER_JS_RUNTIME=deno:/usr/local/bin/deno

EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',{headers:{'X-Downloader-Secret':process.env.MEDIA_DOWNLOADER_SECRET||''}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "services/media-downloader/dist/services/media-downloader/src/index.js"]