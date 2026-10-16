import { isIPv4, isIPv6 } from "node:net";

const HOUR_MS = 3_600_000;
const HOURS_PER_DAY = 24;
const PRUNE_ABOVE = 1000;

/**
 * In-memory signup throttle: a per-network hourly window plus a global cap over the last 24 hours,
 * of which any one hour may spend only its 1/24 share, so a burst can't block signups for a day.
 * IP addresses are never written to disk and are forgotten after an hour.
 */
export class SignupLimiter {
  private byIp: ReadonlyMap<string, readonly number[]> = new Map();
  // Signups per clock hour (hour number -> count) over the last 24 hours.
  private hours: ReadonlyMap<number, number> = new Map();
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
    const hours = new Map([...this.hours].filter(([h]) => hour - h < HOURS_PER_DAY));
    const thisHour = hours.get(hour) ?? 0;
    const lastDay = [...hours.values()].reduce((sum, n) => sum + n, 0);
    const key = networkOf(ip);
    const recent = (this.byIp.get(key) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= this.perIpPerHour || thisHour >= this.perHour || lastDay >= this.perDay) return false;
    this.hours = new Map([...hours, [hour, thisHour + 1]]);
    this.byIp = this.prune(new Map([...this.byIp, [key, [...recent, now]]]), now);
    return true;
  }

  private prune(map: Map<string, readonly number[]>, now: number): ReadonlyMap<string, readonly number[]> {
    if (map.size <= PRUNE_ABOVE) return map;
    return new Map([...map].filter(([, times]) => times.some((t) => now - t < HOUR_MS)));
  }
}

/** IPv6 addresses by their /64 (one customer's usual allocation); IPv4 and anything else as is. */
export function networkOf(address: string): string {
  const ip = address.split("%")[0];
  const mapped = ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : "";
  if (isIPv4(mapped)) return mapped;
  if (!isIPv6(ip)) return address;
  // An embedded dotted IPv4 tail is two groups; it only ever sits in the low 64 bits.
  const groups = (part: string) => (part ? part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const [head, tail] = ip.split("::");
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const full = [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
