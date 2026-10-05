import { dirname } from "node:path";
import { createServer } from "./app.js";
import { loadConfig } from "./config.js";
import { loadFonts } from "./fonts.js";
import { loadLandingPage, loadLegalPages } from "./landing.js";
import { renderSetupGuide } from "./setupGuide.js";
import { FileStore } from "./store.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const store = await FileStore.open(config.dataDir);
  const server = createServer(config, store, Date.now, {
    landing: await loadLandingPage(config.landingPage, config.publicBaseUrl),
    setup: renderSetupGuide(config.publicBaseUrl),
    legal: await loadLegalPages(dirname(config.landingPage), config.publicBaseUrl),
    fonts: await loadFonts(dirname(config.landingPage)),
  });

  const sweep = async () => {
    try {
      const removed = await store.sweep(Date.now());
      if (removed.length > 0) console.log(`[share-host] swept ${removed.length} expired file(s)`);
    } catch (err) {
      console.error("[share-host] sweep failed:", err);
    }
  };
  await sweep();
  const timer = setInterval(sweep, config.sweepIntervalMs);

  server.listen(config.port, () => {
    console.log(`[share-host] listening on :${config.port}, public base ${config.publicBaseUrl}`);
  });

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[share-host] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
