import { describe, expect, it } from "vitest";
import { SignupLimiter } from "../src/signupLimiter.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("SignupLimiter", () => {
  it("allows a few signups per IP per hour, then refuses until the hour has passed", () => {
    const limiter = new SignupLimiter(2, 100);
    expect(limiter.allow("1.1.1.1", 0)).toBe(true);
    expect(limiter.allow("1.1.1.1", 1000)).toBe(true);
    expect(limiter.allow("1.1.1.1", 2000)).toBe(false);
    expect(limiter.allow("2.2.2.2", 2000)).toBe(true);
    expect(limiter.allow("1.1.1.1", HOUR + 1)).toBe(true);
  });

  it("caps signups per day across all IPs", () => {
    const limiter = new SignupLimiter(10, 3);
    expect([1, 2, 3, 4].map((n) => limiter.allow(`10.0.0.${n}`, n))).toEqual([true, true, true, false]);
    expect(limiter.allow("10.0.0.9", DAY + 10)).toBe(true);
  });

  it("does not count refused attempts against the daily cap", () => {
    const limiter = new SignupLimiter(1, 2);
    limiter.allow("a", 0);
    limiter.allow("a", 1);
    limiter.allow("a", 2);
    expect(limiter.allow("b", 3)).toBe(true);
  });
});
