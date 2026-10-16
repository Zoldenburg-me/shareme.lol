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
 * burst can't block signups for a day.
 * IP addresses are never written to disk and are forgotten after an hour.
 */
export class SignupLimiter {
  private byIp: ReadonlyMap<string, readonly number[]> = new Map();
  // Times of the signups in the last 24 hours; never more than perDay of them.
  private lastDay: readonly number[] = [];
  private readonly perHour: number;

  constructor(
    private readonly perIpPerHour: number,
    private readonly perDay: number,
  ) {
    this.perHour = Math.ceil(perDay / HOURS_PER_DAY);
  }

  /** Returns true and records the signup if it is within all limits. */
  allow(ip: string, now: number): boolean {
    const hour = Math.floor(now / HOUR_MS);
    const lastDay = this.lastDay.filter((t) => now - t < DAY_MS);
    const thisHour = lastDay.filter((t) => Math.floor(t / HOUR_MS) === hour).length;
    // An IPv6 /48 (one site) gets twice a /64's allowance; for IPv4 both keys are the same address.
    const limits = new Map([
      [networkOf(ip, SITE_GROUPS), SITE_FACTOR * this.perIpPerHour],
      [networkOf(ip), this.perIpPerHour],
    ]);
    const recent = new Map([...limits.keys()].map((k) => [k, (this.byIp.get(k) ?? []).filter((t) => now - t < HOUR_MS)]));
    const networkFull = [...limits].some(([k, limit]) => (recent.get(k)?.length ?? 0) >= limit);
    if (networkFull || thisHour >= this.perHour || lastDay.length >= this.perDay) return false;
    this.lastDay = [...lastDay, now];
    const recorded = [...recent].map(([k, times]): [string, readonly number[]] => [k, [...times, now]]);
    this.byIp = this.prune(new Map([...this.byIp, ...recorded]), now);
    return true;
  }

  private prune(map: Map<string, readonly number[]>, now: number): ReadonlyMap<string, readonly number[]> {
    if (map.size <= PRUNE_ABOVE) return map;
    return new Map([...map].filter(([, times]) => times.some((t) => now - t < HOUR_MS)));
  }
}

/**
 * IPv6 addresses by their first `prefixGroups` 16-bit groups (default /64, one customer's usual
 * allocation); IPv4-mapped IPv6 as the IPv4 address; IPv4 and anything else as is.
 */
export function networkOf(address: string, prefixGroups = 4): string {
  const g = ipv6Groups(address);
  if (!g) return address;
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".");
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
