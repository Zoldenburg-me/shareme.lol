const PRUNE_ABOVE = 10_000;

interface Window {
  readonly start: number;
  readonly count: number;
}

/**
 * In-memory fixed-window counter per key (a client IP or a token id). Keys are never written
 * to disk and are dropped once their window has passed.
 */
export class RateLimiter {
  // Mutated in place: copying the map on every request would cost O(clients) per hit.
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Milliseconds until `key` may try again without counting a hit; 0 if it is under the limit. */
  retryAfter(key: string, now: number): number {
    const current = this.windows.get(key);
    if (!current || now - current.start >= this.windowMs || current.count < this.limit) return 0;
    return current.start + this.windowMs - now;
  }

  /** Counts a hit for `key`. Returns 0 if allowed, otherwise the milliseconds until it may retry. */
  take(key: string, now: number): number {
    const current = this.windows.get(key);
    const window = current && now - current.start < this.windowMs ? current : { start: now, count: 0 };
    if (window.count >= this.limit) return window.start + this.windowMs - now;
    this.windows.set(key, { start: window.start, count: window.count + 1 });
    if (this.windows.size > PRUNE_ABOVE) this.prune(now);
    return 0;
  }

  private prune(now: number): void {
    for (const [key, w] of this.windows) {
      if (now - w.start >= this.windowMs) this.windows.delete(key);
    }
  }
}
