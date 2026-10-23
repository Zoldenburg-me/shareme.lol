// First patched release per line of the Node.js 2026-10-21 security release (Brotli RCE, TLS hostname bypasses).
const PATCHED: Record<number, [number, number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
const LATEST_PATCHED_MAJOR = 26;

export function isPatchedNode(version: string): boolean {
  const [major, minor, patch] = version.replace(/^v/, "").split(/[-+]/)[0].split(".").map(Number);
  if (major > LATEST_PATCHED_MAJOR) return true;
  const fixed = PATCHED[major];
  if (!fixed) return false;
  return minor > fixed[0] || (minor === fixed[0] && patch >= fixed[1]);
}
