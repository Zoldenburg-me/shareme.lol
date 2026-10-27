// Akash Console managed-wallet API for the shareme.lol deployment.
//
//   node scripts/akash.mjs go [provider]  # create, wait for bids, lease a vetted provider (or this one)
//   node scripts/akash.mjs bids           # list bids for the saved dseq
//   node scripts/akash.mjs update [image] # switch share-host to a new image and resend its env
//                                       # (secrets included); keeps lease and /data
//                                       # (default image: the CI image of the current commit)
//   node scripts/akash.mjs status         # deployment + lease state (no secrets)
//   node scripts/akash.mjs close          # close it; unspent funds return, /data is wiped
//
// Run it as `scripts/secrets.sh run -- node scripts/akash.mjs …`: the secrets (AKASH_CONSOLE_API_KEY and
// sdl-secrets.mjs's SECRET_ENV) come from .env.age, decrypted into the environment only. SDL:
// host/deploy.local.yaml, whose secret entries stay empty. State (dseq, provider; never the manifest, which
// holds the secrets) goes to .private/akash/state.json. Nothing here prints a secret.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fillSecrets, hostEnv } from "./sdl-secrets.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STATE = path.join(ROOT, ".private/akash/state.json");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
// Older versions kept the manifest, which holds every secret, in the state file: drop it first thing.
if ("manifest" in state) {
  delete state.manifest;
  save();
  console.error("removed the old manifest from .private/akash/state.json; it held the deploy secrets in plaintext, so rotate them (secrets.sh set NAME --replace, then update)");
}
// A plaintext ./.env still works for the Console key, and only for it; the deploy secrets come from .env.age.
const DOTENV = path.join(ROOT, ".env");
const env = process.env;
const KEY = env.AKASH_CONSOLE_API_KEY || (existsSync(DOTENV) ? parseEnv(readFileSync(DOTENV, "utf8")).AKASH_CONSOLE_API_KEY : undefined);
if (!KEY) throw new Error("add AKASH_CONSOLE_API_KEY to .env.age (scripts/secrets.sh set AKASH_CONSOLE_API_KEY)");
const BASE = "https://console-api.akash.network";
const SDL = path.join(ROOT, "host/deploy.local.yaml");
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

const readTemplate = () => readFileSync(SDL, "utf8");
const readSdl = () => fillSecrets(readTemplate(), env);

const openBids = async (dseq) =>
  ((await api("GET", `/v1/bids?dseq=${dseq}`)).data ?? []).map((b) => b.bid ?? b).filter((b) => b.state === "open");

async function leaseBid(bid, manifest) {
  const { dseq, gseq, oseq, provider } = bid.id;
  await api("POST", "/v1/leases", { manifest, leases: [{ dseq, gseq, oseq, provider }] });
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
  // The manifest holds every secret, so it stays in memory: leasing happens in this run or not at all.
  const { manifest } = r.data;
  state.dseq = r.data.dseq;
  save();
  console.log(`created deployment dseq ${state.dseq}; waiting for bids…`);
  let chosen;
  for (let i = 0; i < BID_POLLS && !chosen; i++) {
    await new Promise((ok) => setTimeout(ok, BID_POLL_MS));
    const open = await openBids(state.dseq);
    chosen = (arg ? [arg] : PREFERRED).map((p) => open.find((b) => b.id.provider === p)).find(Boolean);
    if (!chosen && i >= 11 && open.length) {
      console.log(`no vetted provider bid; open bids: ${open.map((b) => `${b.id.provider} (${perMonth(b.price.amount)} ACT/month)`).join(", ")}`);
      break;
    }
  }
  if (!chosen) throw new Error("no vetted bid — nothing leased. `close` to get the deposit back, then retry `go`, or `go <provider>` for a provider listed above (it has to bid again)");
  await leaseBid(chosen, manifest);
} else if (cmd === "bids") {
  const bids = await openBids(need());
  if (!bids.length) console.log("no open bids — wait 30–60 s and ask again");
  for (const b of bids) console.log(`${b.id.provider}  ${b.price.amount} ${b.price.denom}/block ≈ ${perMonth(b.price.amount)} ACT/month`);
} else if (cmd === "update") {
  // PATCH sends the image and share-host's whole env, secrets from .env.age. Prints names and states only.
  const image = arg ?? headImage();
  if (!/^ghcr\.io\/[\w./-]+:[\w.-]+$/.test(image)) throw new Error("usage: update [ghcr.io/<owner>/share-me-host:<tag>]");
  const hostVars = hostEnv(readTemplate(), env);
  console.log(`share-host env sent: ${Object.keys(hostVars).join(", ")}`);
  const r = await api("PATCH", `/v1/deployments/${need()}`, { data: { services: { "share-host": { image, env: hostVars } } } });
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
  delete state.dseq; delete state.provider;
  save();
} else {
  console.log("usage: go [provider] | bids | update [image] | status | close");
}
