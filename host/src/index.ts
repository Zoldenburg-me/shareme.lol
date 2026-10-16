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
import { createReconciler, paymentHolds } from "./extend.js";
import { openPayments } from "./x402.js";

const RECONCILE_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const store = await FileStore.open(config.dataDir);
  const tokens = await TokenStore.open(config.dataDir);
  const orphans = await purgeOrphanedFiles(store, tokens);
  if (orphans > 0) console.log(`[share-host] removed ${orphans} file(s) left by revoked tokens`);
  const payments = config.x402 && openPayments(config.x402, config.dataDir, config.publicBaseUrl);
  const server = createServer(config, store, Date.now, {
    landing: await loadLandingPage(config.landingPage, config.publicBaseUrl),
    setup: renderSetupGuide(config.publicBaseUrl),
    legal: await loadLegalPages(dirname(config.landingPage), config.publicBaseUrl),
    fonts: await loadFonts(dirname(config.landingPage)),
  }, {
    tokens,
    limiter: new SignupLimiter(config.signupsPerIpPerHour, config.signupsPerDay),
  }, payments);
  if (config.x402) console.log(`[share-host] taking x402 payments on ${config.x402.network}, settling them itself`);
  // Settles, expires or reports payments whose request ended before settlement, extends their links, prunes used claims.
  const reconcileOnce = payments && createReconciler(store, payments);
  const reconcileNow = async () => {
    if (!reconcileOnce) return;
    try {
      const r = await reconcileOnce(Date.now());
      if (r.settled + r.refused + r.delivered > 0) {
        console.log(`[share-host] reconciled payments: ${r.settled} settled, ${r.refused} refused, ${r.delivered} delivered, ${r.open} open`);
      }
    } catch (err) {
      payments.acceptor.reportError(err);
    }
  };
  // Before the first sweep, so payments that settled while the host was down extend their links first.
  await reconcileNow();
  const reconcile = setInterval(reconcileNow, RECONCILE_INTERVAL_MS);

  const sweep = async () => {
    try {
      // Links with a payment still settling (or settled, not yet extended) stay until it's resolved.
      const keep = payments ? await paymentHolds(payments) : undefined;
      const removed = await store.sweep(Date.now(), keep);
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
    clearInterval(reconcile);
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
