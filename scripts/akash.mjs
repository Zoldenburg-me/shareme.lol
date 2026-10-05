// Akash Console managed-wallet API for the shareme.lol deployment.
//
//   node scripts/akash.mjs go             # create, wait for bids, lease a vetted provider
//   node scripts/akash.mjs bids           # list bids for the saved dseq
//   node scripts/akash.mjs lease <provider>   # accept that provider's bid
//   node scripts/akash.mjs update [image] # switch share-host to a new image; keeps lease and /data
//                                       # (default: the CI image of the current commit)
//   node scripts/akash.mjs status         # deployment + lease state (no secrets)
//   node scripts/akash.mjs close          # close it; unspent funds return, /data is wiped
//
// Needs AKASH_CONSOLE_API_KEY in ./.env. SDL: host/deploy.local.yaml (holds the tokens).
// State (dseq, manifest) goes to .private/akash/state.json. Nothing here prints a secret.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const ROOT = path.resolve(import.meta.dirname, "..");
const env = parseEnv(readFileSync(path.join(ROOT, ".env"), "utf8"));
const KEY = env.AKASH_CONSOLE_API_KEY;
if (!KEY) throw new Error("add AKASH_CONSOLE_API_KEY to .env");
const BASE = "https://console-api.akash.network";
const SDL = path.join(ROOT, "host/deploy.local.yaml");
const STATE = path.join(ROOT, ".private/akash/state.json");
const BLOCKS_PER_MONTH = 438_000; // ~6 s blocks
// Vetted on 2026-09-29 (audited, >=98% 7-day uptime), in order of preference.
const PREFERRED = [
  "akash1aaul837r7en7hpk9wv2svg8u78fdq0t2j2e82z", // Sofia, EU
  "akash15ksejj7g4su7ljufsg0a8eglvkje94z8qsh68a", // Florida
  "akash1k94uya5rhrtj9rfw850az9aq2d6vdpjmtnlgd0", // Michigan
  "akash15tl6v6gd0nte0syyxnv57zmmspgju4c3xfmdhk", // California
];
const BID_POLLS = 18;
const BID_POLL_MS = 5000;

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
const perMonth = (amount) => ((Number(amount) * BLOCKS_PER_MONTH) / 1e6).toFixed(2);

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${(typeof json === "string" ? json : JSON.stringify(json)).slice(0, 500)}`);
  return json;
}

function readSdl() {
  const sdl = readFileSync(SDL, "utf8");
  if (/REPLACE_WITH_/.test(sdl)) throw new Error("host/deploy.local.yaml still has a REPLACE_WITH_ placeholder (tunnel token?)");
  return sdl;
}

const openBids = async (dseq) =>
  ((await api("GET", `/v1/bids?dseq=${dseq}`)).data ?? []).map((b) => b.bid ?? b).filter((b) => b.state === "open");

async function leaseBid(bid) {
  const { dseq, gseq, oseq, provider } = bid.id;
  await api("POST", "/v1/leases", { manifest: state.manifest, leases: [{ dseq, gseq, oseq, provider }] });
  state.provider = provider;
  save();
  console.log(`lease created with ${provider} at ${bid.price.amount} ${bid.price.denom}/block ≈ ${perMonth(bid.price.amount)} ACT/month`);
}

// CI tags every main build sha-<commit>; only pushed commits have an image.
function headImage() {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  const sha = git("rev-parse", "HEAD");
  if (!git("branch", "-r", "--contains", sha).split("\n").some((b) => b.trim() === "origin/main")) {
    throw new Error(`commit ${sha.slice(0, 7)} is not on origin/main yet; push it and wait for the host-image build`);
  }
  return `ghcr.io/zoldenburg-me/share-me-host:sha-${sha}`;
}

const need = () => { if (!state.dseq) throw new Error("no deployment yet — run go"); return state.dseq; };
const [cmd, arg] = process.argv.slice(2);

if (cmd === "go") {
  // Bids close after a few minutes, so create and lease in one run.
  if (state.dseq) throw new Error(`deployment ${state.dseq} already exists — close it first`);
  const r = await api("POST", "/v1/deployments", { data: { sdl: readSdl() } });
  state.dseq = r.data.dseq;
  state.manifest = r.data.manifest;
  save();
  console.log(`created deployment dseq ${state.dseq}; waiting for bids…`);
  let chosen;
  for (let i = 0; i < BID_POLLS && !chosen; i++) {
    await new Promise((ok) => setTimeout(ok, BID_POLL_MS));
    const open = await openBids(state.dseq);
    chosen = PREFERRED.map((p) => open.find((b) => b.id.provider === p)).find(Boolean);
    if (!chosen && i >= 11 && open.length) {
      console.log(`no vetted provider bid; open bids: ${open.map((b) => `${b.id.provider} (${perMonth(b.price.amount)} ACT/month)`).join(", ")}`);
      break;
    }
  }
  if (!chosen) throw new Error("no vetted bid — nothing leased. `bids` + `lease <provider>` to pick another, or `close` to get the deposit back");
  await leaseBid(chosen);
} else if (cmd === "bids") {
  const bids = await openBids(need());
  if (!bids.length) console.log("no open bids — wait 30–60 s and ask again");
  for (const b of bids) console.log(`${b.id.provider}  ${b.price.amount} ${b.price.denom}/block ≈ ${perMonth(b.price.amount)} ACT/month`);
} else if (cmd === "lease") {
  if (!arg) throw new Error("usage: lease <provider address>");
  const bid = (await openBids(need())).find((b) => b.id.provider === arg);
  if (!bid) throw new Error(`no open bid from ${arg}`);
  await leaseBid(bid);
} else if (cmd === "update") {
  // PATCH touches only the image; env values (tokens) stay as stored. Prints states only.
  const image = arg ?? headImage();
  if (!/^ghcr\.io\/[\w./-]+:[\w.-]+$/.test(image)) throw new Error("usage: update [ghcr.io/<owner>/share-me-host:<tag>]");
  const r = await api("PATCH", `/v1/deployments/${need()}`, { data: { services: { "share-host": { image } } } });
  const d = r.data ?? {};
  console.log(JSON.stringify({
    dseq: state.dseq,
    image,
    state: d.deployment?.state,
    leases: (d.leases ?? []).map((l) => ({ provider: l.id?.provider, state: l.state, status: l.status ? "reported" : null })),
  }, null, 2));
} else if (cmd === "status") {
  // Only states: the manifest echoed by the API carries every secret.
  const d = (await api("GET", `/v1/deployments/${need()}`)).data ?? {};
  console.log(JSON.stringify({
    dseq: state.dseq,
    provider: state.provider,
    state: d.deployment?.state ?? d.deployment?.deployment?.state,
    leases: (d.leases ?? []).map((l) => ({ provider: l.id?.provider ?? l.lease?.id?.provider, state: l.state ?? l.lease?.state })),
  }, null, 2));
} else if (cmd === "close") {
  await api("DELETE", `/v1/deployments/${need()}`);
  console.log(`closed deployment ${state.dseq}`);
  delete state.dseq; delete state.manifest; delete state.provider;
  save();
} else {
  console.log("usage: go | bids | lease <provider> | update <image> | status | close");
}
