const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PRUNE_ABOVE = 1000;

/**
 * In-memory signup throttle: a per-IP hourly window plus a global daily cap.
 * IP addresses are never written to disk and are forgotten after an hour.
 */
export class SignupLimiter {
  private byIp: ReadonlyMap<string, readonly number[]> = new Map();
  private day = { start: 0, count: 0 };

  constructor(
    private readonly perIpPerHour: number,
    private readonly perDay: number,
  ) {}

  /** Returns true and records the signup if it is within both limits. */
  allow(ip: string, now: number): boolean {
    if (now - this.day.start >= DAY_MS) this.day = { start: now, count: 0 };
    const recent = (this.byIp.get(ip) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= this.perIpPerHour || this.day.count >= this.perDay) return false;
    this.day = { ...this.day, count: this.day.count + 1 };
    this.byIp = this.prune(new Map([...this.byIp, [ip, [...recent, now]]]), now);
    return true;
  }

  private prune(map: Map<string, readonly number[]>, now: number): ReadonlyMap<string, readonly number[]> {
    if (map.size <= PRUNE_ABOVE) return map;
    return new Map([...map].filter(([, times]) => times.some((t) => now - t < HOUR_MS)));
  }
}
