// Fills the SDL's secrets from the environment, in memory only. Run akash.mjs under
// `scripts/secrets.sh run`, which decrypts .env.age into its environment (as the Zold app does);
// host/deploy.local.yaml lists each secret with an empty value and never holds one.

// Env names that hold secrets. X402_HUB_KEY is optional (paid extensions); the others every deploy needs.
export const SECRET_ENV = new Set(["SHARE_API_TOKEN", "TUNNEL_TOKEN", "X402_HUB_KEY"]);
const REQUIRED = ["SHARE_API_TOKEN", "TUNNEL_TOKEN"];
const ENTRY = /^(\s+)-\s+([A-Z0-9_]+)=(.*)$/;
const valueOf = (raw) => raw.replace(/\s+#.*$/, "").trim();
const SECRET_NAME = new RegExp(`\\b(${[...SECRET_ENV].join("|")})\\b`);

export function secretValue(name, inFile, env) {
  if (valueOf(inFile)) {
    throw new Error(`${name} has a value in host/deploy.local.yaml: move it into .env.age (scripts/secrets.sh set ${name}) and leave it empty there`);
  }
  const value = env[name];
  if (!value) throw new Error(`${name} is not set: run this under scripts/secrets.sh run -- node scripts/akash.mjs …`);
  return value;
}

// The SDL's lines, refusing a secret written in any form other than `- NAME=` (quoted, spaced, flow
// style): those would slip past the check for a value in the file.
function sdlLines(sdl) {
  const lines = sdl.split(/\r?\n/);
  for (const line of lines) {
    const name = SECRET_NAME.exec(line.replace(/#.*$/, ""))?.[1];
    if (name && ENTRY.exec(line)?.[2] !== name) {
      throw new Error(`write ${name} in host/deploy.local.yaml as an unquoted, empty \`- ${name}=\` entry`);
    }
  }
  return lines;
}

/** The SDL text with every secret entry filled in from env. */
export function fillSecrets(sdl, env) {
  const seen = new Set();
  const filled = sdlLines(sdl).map((line) => {
    const m = ENTRY.exec(line);
    if (!m || !SECRET_ENV.has(m[2])) return line;
    seen.add(m[2]);
    // A JSON string is a valid YAML double-quoted scalar, whatever the value holds.
    return `${m[1]}- ${JSON.stringify(`${m[2]}=${secretValue(m[2], m[3], env)}`)}`;
  }).join("\n");
  const missing = REQUIRED.filter((name) => !seen.has(name));
  if (missing.length) throw new Error(`host/deploy.local.yaml has no ${missing.join(" or ")} entry: add it empty, as in host/deploy.yaml`);
  return filled;
}

/** share-host's env from the SDL template as {name: value}, secrets filled in from env. */
export function hostEnv(sdl, env) {
  const lines = sdlLines(sdl);
  const start = lines.findIndex((l) => /^  share-host:\s*$/.test(l));
  const envAt = lines.findIndex((l, i) => i > start && /^    env:\s*$/.test(l));
  if (start < 0 || envAt < 0) throw new Error("no share-host env block in host/deploy.local.yaml");
  const entries = [];
  for (const line of lines.slice(envAt + 1)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const m = ENTRY.exec(line);
    if (!m) {
      // Another list item of the env block would be dropped from the update, with everything after it.
      if (/^\s{6,}-/.test(line)) throw new Error("share-host's env in host/deploy.local.yaml: write each entry as an unquoted `- NAME=value`");
      break;
    }
    entries.push([m[2], SECRET_ENV.has(m[2]) ? secretValue(m[2], m[3], env) : valueOf(m[3])]);
  }
  const vars = Object.fromEntries(entries);
  if (!("SHARE_API_TOKEN" in vars)) throw new Error("share-host's env in host/deploy.local.yaml has no SHARE_API_TOKEN entry");
  return vars;
}
