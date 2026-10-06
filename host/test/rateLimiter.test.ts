import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rateLimiter.js";

describe("RateLimiter", () => {
  it("allows up to the limit per window, then reports how long to wait", () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.take("a", 0)).toBe(0);
    expect(limiter.take("a", 100)).toBe(0);
    expect(limiter.take("a", 400)).toBe(600);
    expect(limiter.take("b", 400)).toBe(0);
  });

  it("starts a fresh window once the old one has passed", () => {
    const limiter = new RateLimiter(1, 1000);
    limiter.take("a", 0);
    expect(limiter.take("a", 999)).toBe(1);
    expect(limiter.take("a", 1000)).toBe(0);
  });

  it("checks a key without counting a hit", () => {
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.retryAfter("a", 0)).toBe(0);
    expect(limiter.retryAfter("a", 0)).toBe(0);
    limiter.take("a", 0);
    expect(limiter.retryAfter("a", 250)).toBe(750);
    expect(limiter.retryAfter("a", 1000)).toBe(0);
  });

  it("forgets expired keys once it tracks many clients", () => {
    const limiter = new RateLimiter(1, 1000);
    for (let i = 0; i <= 10_000; i++) limiter.take(`ip${i}`, 0);
    limiter.take("late", 5000);
    expect(limiter.take("ip0", 5000)).toBe(0);
  });
});
