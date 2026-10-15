/**
 * Sidecar entrypoint.
 *
 * Boots config, prepares the work directory, starts the HTTP server, and wires
 * graceful shutdown so in-flight yt-dlp processes get killed rather than
 * orphaned when the container is recycled.
 */

import { loadConfig } from "./config";
import { JobStore } from "./job-store";
import { PlatformBreakers } from "./platform-breaker";
import { createServerFor } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new JobStore(config);
  await store.init();

  const breakers = new PlatformBreakers({
    failureThreshold: config.breakerFailureThreshold,
    cooldownMs: config.breakerCooldownMs,
  });

  const server = createServerFor(config, store, breakers);

  await new Promise<void>((resolve) => {
    server.listen(config.port, "0.0.0.0", resolve);
  });

  console.info(
    `[media-downloader] listening on :${config.port} ` +
      `(jobs ${config.maxConcurrentJobs}, workdir ${config.workDir}, origins ${config.allowedOrigins.join(",")})`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[media-downloader] ${signal} received, draining`);

    server.close(() => {
      void store.shutdown().finally(() => process.exit(0));
    });

    // Do not hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  /**
   * Backstop. Node >=15 exits the process on an unhandled rejection, so one
   * stray `await stat()` on a vanished file would take down every in-flight
   * download. Log loudly, keep serving.
   */
  process.on("unhandledRejection", (reason) => {
    console.error("[media-downloader] unhandled rejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[media-downloader] uncaught exception:", error);
  });
}

main().catch((error: unknown) => {
  console.error("[media-downloader] failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});