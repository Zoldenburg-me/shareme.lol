/**
 * Adds or replaces one variable in a dotenv text, for `secrets.sh set`.
 *
 *   node env-set.mjs NAME [--replace] [--random [--prefix STR]] 3<current 4<value > new
 *
 * The current text comes in on fd 3 and the value on fd 4 (one line; a single
 * trailing newline is dropped). `--random` makes the value instead: 32 random
 * bytes as base64, after an optional prefix such as `k1:`. The new text goes to
 * stdout, which secrets.sh pipes straight into age, so nothing here touches a
 * file. Every existing line is kept as it was; the variable is appended, after
 * removing its old line when --replace is given.
 *
 * The result is checked with node's parseEnv, the parser `secrets.sh run`
 * uses: it must hold every earlier value unchanged plus the new one, or
 * nothing is written. Messages name the variable, never a value.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const USAGE = "usage: env-set.mjs NAME [--replace] [--random [--prefix STR]] 3<current 4<value";
const NAME = /^[A-Z_][A-Z0-9_]*$/;

function refuse(message) {
  console.error(message);
  process.exit(1);
}

const [name, ...flags] = process.argv.slice(2);
if (!name) refuse(USAGE);
// Not echoed: a value typed where the name goes would be printed.
if (!NAME.test(name)) refuse("the first argument is not a variable name (A-Z, 0-9 and _, not starting with a digit)");
const replace = flags.includes("--replace");
const random = flags.includes("--random");
const prefixAt = flags.indexOf("--prefix");
const prefix = prefixAt >= 0 ? flags[prefixAt + 1] ?? refuse(USAGE) : "";
if (prefix.startsWith("--")) refuse(USAGE);
const known = new Set(["--replace", "--random", "--prefix", prefix]);
for (const f of flags) if (!known.has(f)) refuse(`an argument is not an option this takes (not echoed)\n${USAGE}`);
if (prefix && !random) refuse("--prefix goes with --random");
if (process.stdout.isTTY) refuse("refusing to print secrets to a terminal: pipe the output into age (secrets.sh set does)");

const readFd = (fd, what) => {
  try {
    return readFileSync(fd, "utf8");
  } catch (err) {
    return refuse(`could not read ${what} on fd ${fd}: ${err.code ?? err.message}`);
  }
};

const current = readFd(3, "the current secrets");
const before = parseEnv(current);
if (Object.hasOwn(before, name) && !replace) refuse(`${name} is already set; pass --replace to overwrite it`);

const value = random ? prefix + randomBytes(32).toString("base64") : readFd(4, "the value").replace(/\r?\n$/, "");
if (!value) refuse(`the value for ${name} is empty`);
if (/[\r\n]/.test(value)) refuse(`the value for ${name} must be one line`);

/** The first spelling that parseEnv reads back as exactly `value`. */
function serialise(v) {
  const candidates = [v, `'${v}'`, `"${v}"`];
  return candidates.find((c) => parseEnv(`X=${c}\n`).X === v);
}
const written = serialise(value);
if (written === undefined) refuse(`the value for ${name} cannot be written as one dotenv value (it mixes quote characters)`);

const ownLine = new RegExp(`^\\s*(export\\s+)?${name}\\s*=.*$\\n?`, "gm");
let next = replace ? current.replace(ownLine, "") : current;
if (next && !next.endsWith("\n")) next += "\n";
next += `${name}=${written}\n`;

const after = parseEnv(next);
const expected = { ...before, [name]: value };
const same = Object.keys(after).length === Object.keys(expected).length && Object.entries(expected).every(([k, v]) => after[k] === v);
if (!same) refuse(`setting ${name} would change other values (a multi-line value in the file?); nothing written`);

process.stdout.write(next);
