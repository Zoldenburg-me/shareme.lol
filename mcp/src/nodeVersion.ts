// First patched release per line of the Node.js 2026-10-21 security release (Brotli RCE, TLS hostname bypasses).
const PATCHED: Record<number, [number, number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
const LATEST_PATCHED_MAJOR = 26;

export function isPatchedNode(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!m) return false;
  const [major, minor, patch] = m.slice(1, 4).map(Number);
  if (major > LATEST_PATCHED_MAJOR) return true;
  const fixed = PATCHED[major];
  if (!fixed) return false;
  // A prerelease comes before its release, so 22.23.4-rc.1 still misses the fix.
  return minor > fixed[0] || (minor === fixed[0] && (patch > fixed[1] || (patch === fixed[1] && !m[4])));
}
