import { dirname } from "node:path";
import { createServer } from "./app.js";
import { loadConfig } from "./config.js";
import { loadFonts } from "./fonts.js";
import { loadLandingPage, loadLegalPages } from "./landing.js";
import { purgeOrphanedFiles } from "./orphans.js";
import { renderSetupGuide } from "./setupGuide.js";
import { SignupLimiter } from "./signupLimiter.js";
import { FileStore } from "./store.js";
import { TokenStore } from "./tokens.js";
import { PaymentLedger } from "./payments.js";
import { httpFacilitator } from "./x402.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const store = await FileStore.open(config.dataDir);
  const tokens = await TokenStore.open(config.dataDir);
  const orphans = await purgeOrphanedFiles(store, tokens);
  if (orphans > 0) console.log(`[share-host] removed ${orphans} file(s) left by revoked tokens`);
  const server = createServer(config, store, Date.now, {
    landing: await loadLandingPage(config.landingPage, config.publicBaseUrl),
    setup: renderSetupGuide(config.publicBaseUrl),
    legal: await loadLegalPages(dirname(config.landingPage), config.publicBaseUrl),
    fonts: await loadFonts(dirname(config.landingPage)),
  }, {
    tokens,
    limiter: new SignupLimiter(config.signupsPerIpPerHour, config.signupsPerDay),
  }, config.x402 && {
    facilitator: httpFacilitator(config.x402.facilitatorUrl, config.x402.facilitatorAuth),
    ledger: new PaymentLedger(config.dataDir),
  });
  if (config.x402) console.log(`[share-host] taking x402 payments on ${config.x402.network} via ${new URL(config.x402.facilitatorUrl).host}`);

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
