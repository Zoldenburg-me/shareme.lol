import { createHmac, randomBytes } from "node:crypto";
import { isIPv6 } from "node:net";

const HOUR_MS = 3_600_000;
const HOURS_PER_DAY = 24;
const DAY_MS = HOURS_PER_DAY * HOUR_MS;
const PRUNE_ABOVE = 1000;
const SITE_GROUPS = 3; // a /48
const SITE_FACTOR = 2;

/**
 * In-memory signup throttle: a per-network hourly window (IPv4 address, IPv6 /64 and /48) plus a
 * global cap over the last 24 hours, of which any one hour may spend only its 1/24 share, so a
 * burst can't block signups for a day. Half of each hour's share is kept for networks with no
 * signup in the last 24 hours, so a few networks coming back every hour can't fill it.
 * IP addresses are never written to disk and stop counting after an hour; the 24-hour memory holds
 * only a keyed hash of the network, under a random key that never leaves the process.
 */
export class SignupLimiter {
  private byIp: ReadonlyMap<string, readonly number[]> = new Map();
  // Times of the signups in the last 24 hours, oldest first; never more than perDay of them.
  private lastDay: number[] = [];
  // Keyed hash of each network (and /48) that signed up in the last 24 hours -> its latest signup.
  private seen = new Map<string, number>();
  private readonly hashKey = randomBytes(32);
  private readonly perHour: number;
  private readonly reserve: number;

  constructor(
    private readonly perIpPerHour: number,
    private readonly perDay: number,
  ) {
    this.perHour = Math.ceil(perDay / HOURS_PER_DAY);
    this.reserve = Math.floor(this.perHour / 2);
  }

  /** Returns true and records the signup if it is within all limits. */
  allow(ip: string, at: number): boolean {
    // lastDay stays sorted only if time never runs backwards, so a clock step back counts as no time passing.
    const now = Math.max(at, this.lastDay.at(-1) ?? at);
    const network = networkOf(ip);
    const site = networkOf(ip, SITE_GROUPS);
    // An IPv6 /48 (one site) also gets twice a /64's allowance; IPv4 has no wider key.
    const limits: readonly [string, number][] = [
      [network, this.perIpPerHour],
      ...(site === network ? [] : [[site, SITE_FACTOR * this.perIpPerHour] as [string, number]]),
    ];
    const recent = new Map(limits.map(([k]) => [k, (this.byIp.get(k) ?? []).filter((t) => now - t < HOUR_MS)]));
    if (limits.some(([k, limit]) => (recent.get(k)?.length ?? 0) >= limit)) return false;

    // Drop expired signups from the front, then count this clock hour from the back: O(perHour), not O(perDay).
    const expired = this.lastDay.findIndex((t) => now - t < DAY_MS);
    this.lastDay.splice(0, expired === -1 ? this.lastDay.length : expired);
    const hour = Math.floor(now / HOUR_MS);
    let thisHour = 0;
    for (let i = this.lastDay.length - 1; i >= 0 && Math.floor(this.lastDay[i] / HOUR_MS) === hour; i--) thisHour++;
    if (thisHour >= this.perHour || this.lastDay.length >= this.perDay) return false;
    const hashes = limits.map(([k]) => this.hash(k));
    const returning = hashes.some((h) => now - (this.seen.get(h) ?? -Infinity) < DAY_MS);
    if (returning && thisHour >= this.perHour - this.reserve) return false;

    this.lastDay.push(now);
    for (const h of hashes) this.seen.set(h, now);
    this.seen = new Map([...this.seen].filter(([, t]) => now - t < DAY_MS));
    const recorded = [...recent].map(([k, times]): [string, readonly number[]] => [k, [...times, now]]);
    this.byIp = this.prune(new Map([...this.byIp, ...recorded]), now);
    return true;
  }

  private hash(key: string): string {
    return createHmac("sha256", this.hashKey).update(key).digest("base64url");
  }

  private prune(map: Map<string, readonly number[]>, now: number): ReadonlyMap<string, readonly number[]> {
    if (map.size <= PRUNE_ABOVE) return map;
    return new Map([...map].filter(([, times]) => times.some((t) => now - t < HOUR_MS)));
  }
}

/**
 * IPv6 addresses by their first `prefixGroups` 16-bit groups (default /64, one customer's usual
 * allocation); IPv4-mapped, NAT64 (64:ff9b::/96) and Teredo (2001::/32) addresses as the client's
 * IPv4 address, so their clients don't all share one key; IPv4 and anything else as is.
 */
export function networkOf(address: string, prefixGroups = 4): string {
  const g = ipv6Groups(address);
  if (!g) return address;
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return v4(g[6], g[7]);
  // Teredo stores the client's public IPv4 inverted in the last 32 bits.
  if (g[0] === 0x2001 && g[1] === 0) return v4(g[6] ^ 0xffff, g[7] ^ 0xffff);
  return `${g.slice(0, prefixGroups).map((n) => n.toString(16)).join(":")}::/${prefixGroups * 16}`;
}

/** The eight 16-bit groups of an IPv6 address, or undefined if it isn't one. */
function ipv6Groups(address: string): number[] | undefined {
  const ip = address.split("%")[0];
  if (!isIPv6(ip)) return undefined;
  const parse = (part: string) => (part ? part.split(":").flatMap((g) => (g.includes(".") ? dottedGroups(g) : [parseInt(g, 16)])) : []);
  const [head, tail] = ip.split("::");
  const front = parse(head);
  const back = tail === undefined ? [] : parse(tail);
  return [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
}

const dottedGroups = (v4: string): number[] => {
  const [a, b, c, d] = v4.split(".").map(Number);
  return [(a << 8) | b, (c << 8) | d];
};
