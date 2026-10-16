import { describe, expect, it } from "vitest";
import { networkOf, SignupLimiter } from "../src/signupLimiter.js";

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
    expect([1, 2, 3, 4].map((n) => limiter.allow(`10.0.0.${n}`, n * HOUR))).toEqual([true, true, true, false]);
    expect(limiter.allow("10.0.0.9", DAY + 2 * HOUR)).toBe(true);
  });

  it("does not count refused attempts against the daily cap", () => {
    const limiter = new SignupLimiter(1, 2);
    limiter.allow("a", 0);
    limiter.allow("a", 1);
    limiter.allow("a", 2);
    expect(limiter.allow("b", HOUR)).toBe(true);
  });

  it("keys IPv6 by /64, so one actor's many addresses share the per-IP limit", () => {
    const limiter = new SignupLimiter(2, 100);
    expect(limiter.allow("2001:db8:1:2::1", 0)).toBe(true);
    expect(limiter.allow("2001:db8:1:2:ffff:0:0:2", 1)).toBe(true);
    expect(limiter.allow("2001:0db8:0001:0002::3", 2)).toBe(false);
    expect(limiter.allow("2001:db8:1:3::1", 3)).toBe(true);
    expect(limiter.allow("::ffff:10.0.0.1", 4)).toBe(true);
    expect(limiter.allow("10.0.0.1", 5)).toBe(true);
    expect(limiter.allow("10.0.0.1", 6)).toBe(false);
    expect(networkOf("1::2:3:4:5:6:7")).toBe("1:0:2:3::/64");
    expect(networkOf("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("spends at most an hourly share of the daily cap, so one burst can't block signups for a day", () => {
    const limiter = new SignupLimiter(1, 48);
    const burst = Array.from({ length: 10 }, (_, n) => limiter.allow(`10.0.${n}.1`, n));
    expect(burst.filter(Boolean)).toHaveLength(2);
    expect(limiter.allow("10.1.0.1", HOUR)).toBe(true);
  });
});
