/**
 * Runs a command with dotenv lines read from file descriptor 3 merged into its
 * environment. secrets.sh decrypts first, refuses on any failure, and only
 * then pipes the plaintext into fd 3, so the values exist in memory and in the
 * child's environment, never in a file.
 *
 * A variable already set in the environment wins, as with process.loadEnvFile;
 * an empty one does not, so a stray `export NAME=` cannot blank a secret.
 * An empty or unreadable fd 3 refuses to start the command rather than
 * starting it without its secrets. The command's exit code, or the signal that
 * killed it, is this process's too.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"];

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: with-env-fd.mjs COMMAND... 3<dotenv");
  process.exit(1);
}

let text = "";
try {
  text = readFileSync(3, "utf8");
} catch (err) {
  console.error(`could not read secrets on fd 3: ${err.code ?? err.message}`);
  process.exit(1);
}
const secrets = parseEnv(text);
if (Object.keys(secrets).length === 0) {
  console.error("no secrets decrypted (wrong identity, or an empty file); not starting the command");
  process.exit(1);
}

const child = spawn(command, args, { stdio: "inherit", env: { ...secrets, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) } });
for (const signal of FORWARDED) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (err) => {
  console.error(`could not start ${command}: ${err.code ?? err.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (!signal) process.exit(code ?? 1);
  // Die of the same signal. Our own handlers would otherwise catch it and
  // the process would exit 0, reporting a killed command as a success.
  for (const s of FORWARDED) process.removeAllListeners(s);
  process.kill(process.pid, signal);
  setTimeout(() => process.exit(128 + (os.constants.signals[signal] ?? 1)), 100);
});
