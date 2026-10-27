import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs deploy script, no types
import { fillSecrets, hostEnv } from "../scripts/sdl-secrets.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SECRETS = join(ROOT, "scripts/secrets.sh");
const fromAgeSh = (name: string) => execFileSync("bash", ["-c", `source scripts/_age.sh && echo "$${name}"`], { cwd: ROOT, encoding: "utf8" }).trim();
const AGE = fromAgeSh("AGE");
const AGE_KEYGEN = fromAgeSh("AGE_KEYGEN");

const HUB_KEY = `zsk_${"ab".repeat(24)}`;
const API_TOKEN = "t0k+en/with=base64chars";
const SDL = `services:
  share-host:
    image: x
    env:
      - SHARE_API_TOKEN=            # secret
      - PUBLIC_BASE_URL=https://shareme.lol
      # - ALLOWED_EXTENSIONS=txt
      - X402_HUB_URL=https://hub.zoldhq.com
      - X402_HUB_KEY=
    expose:
  cloudflared:
    env:
      - TUNNEL_TOKEN=
`;
const TUNNEL = "eyJhIjoi-tunnel";
const PRINT = ["node", "-e", "process.stdout.write(JSON.stringify({ t: process.env.SHARE_API_TOKEN, k: process.env.X402_HUB_KEY }))"];

describe("deploy secrets: .env.age → akash.mjs's environment → SDL", () => {
  let dir: string;
  let identity: string;
  let encrypted: string;
  let recipients: string;

  const run = (identityFile: string) =>
    spawnSync(SECRETS, ["run", "--", ...PRINT], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, AGE_IDENTITY_FILE: identityFile, SECRETS_ENV_FILE: encrypted },
    });

  beforeEach(async () => {
    if (!existsSync(AGE)) throw new Error("age is not installed: run scripts/fetch-age.sh");
    dir = await mkdtemp(join(tmpdir(), "share-secrets-"));
    identity = join(dir, "identity");
    execFileSync(AGE_KEYGEN, ["-o", identity], { stdio: "ignore" });
    recipients = join(dir, "recipients");
    await writeFile(recipients, execFileSync(AGE_KEYGEN, ["-y", identity], { encoding: "utf8" }));
    const plain = join(dir, "env");
    await writeFile(plain, `SHARE_API_TOKEN=${API_TOKEN}\nX402_HUB_KEY=${HUB_KEY}\n`);
    execFileSync(SECRETS, ["encrypt", plain], { env: { ...process.env, AGE_RECIPIENTS_FILE: recipients }, stdio: "ignore" });
    await rm(plain);
    encrypted = `${plain}.age`;
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("decrypts into the command's environment and fills the SDL from it", () => {
    const r = run(identity);
    expect(r.status).toBe(0);
    const decrypted = JSON.parse(r.stdout) as { t: string; k: string };
    expect(decrypted).toEqual({ t: API_TOKEN, k: HUB_KEY });

    const env = { SHARE_API_TOKEN: decrypted.t, X402_HUB_KEY: decrypted.k, TUNNEL_TOKEN: TUNNEL };
    const filled = fillSecrets(SDL, env);
    expect(filled).toContain(`      - ${JSON.stringify(`SHARE_API_TOKEN=${API_TOKEN}`)}`);
    expect(filled).toContain(`      - ${JSON.stringify(`X402_HUB_KEY=${HUB_KEY}`)}`);
    expect(filled).toContain("      - PUBLIC_BASE_URL=https://shareme.lol");
    expect(filled).toContain(`      - ${JSON.stringify(`TUNNEL_TOKEN=${TUNNEL}`)}`);
    // a file saved with Windows line endings is read the same
    expect(fillSecrets(SDL.replace(/\n/g, "\r\n"), env)).toBe(filled);
    expect(hostEnv(SDL, env)).toEqual({ SHARE_API_TOKEN: API_TOKEN, PUBLIC_BASE_URL: "https://shareme.lol", X402_HUB_URL: "https://hub.zoldhq.com", X402_HUB_KEY: HUB_KEY });
  });

  it("refuses to start the command with the wrong identity", async () => {
    const other = join(dir, "other");
    execFileSync(AGE_KEYGEN, ["-o", other], { stdio: "ignore" });
    const r = run(other);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("could not decrypt");
  });

  it("refuses a secret written into the SDL file, or one missing from the environment", () => {
    expect(() => fillSecrets(SDL.replace("X402_HUB_KEY=", `X402_HUB_KEY=${HUB_KEY}`), { SHARE_API_TOKEN: API_TOKEN })).toThrow(/has a value in host\/deploy.local.yaml/);
    // an old deploy.local.yaml still has the template's placeholder in it
    expect(() => hostEnv(SDL.replace("SHARE_API_TOKEN=", "SHARE_API_TOKEN=REPLACE_WITH_OUTPUT_OF_openssl_rand_-base64_48"), { SHARE_API_TOKEN: API_TOKEN, X402_HUB_KEY: HUB_KEY })).toThrow(/SHARE_API_TOKEN has a value/);
    expect(() => hostEnv(SDL, { SHARE_API_TOKEN: API_TOKEN })).toThrow(/X402_HUB_KEY is not set/);
  });

  it("refuses secret entries it cannot check, and a missing required one", () => {
    const env = { SHARE_API_TOKEN: API_TOKEN, X402_HUB_KEY: HUB_KEY, TUNNEL_TOKEN: TUNNEL };
    for (const form of [`"X402_HUB_KEY=${HUB_KEY}"`, `'X402_HUB_KEY=${HUB_KEY}'`, `X402_HUB_KEY = ${HUB_KEY}`]) {
      const sdl = SDL.replace("- X402_HUB_KEY=", `- ${form}`);
      expect(() => fillSecrets(sdl, env)).toThrow(/unquoted, empty `- X402_HUB_KEY=`/);
      expect(() => hostEnv(sdl, env)).toThrow(/unquoted, empty `- X402_HUB_KEY=`/);
    }
    expect(() => hostEnv(SDL.replace("- PUBLIC_BASE_URL=https://shareme.lol", `- "PUBLIC_BASE_URL=https://shareme.lol"`), env)).toThrow(/unquoted `- NAME=value`/);
    expect(() => fillSecrets(SDL.replace("- TUNNEL_TOKEN=", "# - TUNNEL_TOKEN="), env)).toThrow(/no TUNNEL_TOKEN entry/);
  });

  it("sets a value through secrets.sh set without touching the others", () => {
    const tricky = `a#b "c" = d`;
    const set = (args: string[], input: string) =>
      spawnSync(SECRETS, ["set", ...args], { input, encoding: "utf8", env: { ...process.env, AGE_IDENTITY_FILE: identity, AGE_RECIPIENTS_FILE: recipients, SECRETS_ENV_FILE: encrypted } });
    expect(set(["TUNNEL_TOKEN"], tricky).status).toBe(0);
    expect(set(["TUNNEL_TOKEN"], "other").stderr).toContain("already set");
    const read = () => JSON.parse(spawnSync(SECRETS, ["run", "--", "node", "-e", "process.stdout.write(JSON.stringify([process.env.SHARE_API_TOKEN, process.env.X402_HUB_KEY, process.env.TUNNEL_TOKEN]))"], {
      encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, AGE_IDENTITY_FILE: identity, SECRETS_ENV_FILE: encrypted },
    }).stdout);
    expect(read()).toEqual([API_TOKEN, HUB_KEY, tricky]);
    expect(set(["TUNNEL_TOKEN", "--replace"], "rotated\n").status).toBe(0);
    expect(read()).toEqual([API_TOKEN, HUB_KEY, "rotated"]);
  });
});
