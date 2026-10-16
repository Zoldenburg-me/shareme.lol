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

  it("counts the daily cap over exactly the last 24 hours, not whole clock hours", () => {
    const limiter = new SignupLimiter(1, 24);
    const lateInEachHour = Array.from({ length: 24 }, (_, h) => limiter.allow(`10.0.${h}.1`, h * HOUR + HOUR - 1));
    expect(lateInEachHour.every(Boolean)).toBe(true);
    expect(limiter.allow("10.1.0.1", DAY + 1)).toBe(false);
    expect(limiter.allow("10.1.0.2", DAY + HOUR - 1)).toBe(true);
  });

  it("gives each clock hour its share, not each rolling hour", () => {
    const limiter = new SignupLimiter(10, 48);
    const allowed = [HOUR - 2, HOUR - 1, HOUR, HOUR + 1].map((t, n) => limiter.allow(`10.0.0.${n}`, t));
    expect(allowed).toEqual([true, true, true, true]);
    expect(limiter.allow("10.0.0.9", HOUR + 2)).toBe(false);
  });

  it("does not record a refused attempt against the network's window", () => {
    const limiter = new SignupLimiter(1, 1000);
    expect(limiter.allow("10.0.0.1", 0)).toBe(true);
    expect(limiter.allow("10.0.0.1", 10)).toBe(false);
    expect(limiter.allow("10.0.0.1", HOUR + 1)).toBe(true);
  });

  it("holds an IPv4 address (plain or mapped) to the per-network limit, with no wider site allowance", () => {
    const limiter = new SignupLimiter(1, 1000);
    expect(limiter.allow("192.0.2.1", 0)).toBe(true);
    expect(limiter.allow("192.0.2.1", 1)).toBe(false);
    expect(limiter.allow("::ffff:192.0.2.1", 2)).toBe(false);
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
    expect(networkOf("0:0:0:0:0:ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(networkOf("::ffff:0102:0304")).toBe("1.2.3.4");
  });

  it("also limits a whole IPv6 /48, so rotating /64s inside it doesn't help", () => {
    const limiter = new SignupLimiter(1, 1000);
    const rotated = [1, 2, 3, 4].map((n) => limiter.allow(`2001:db8:1:${n}::1`, n));
    expect(rotated).toEqual([true, true, false, false]);
    expect(limiter.allow("2001:db8:2:1::1", 5)).toBe(true);
    expect([6, 7].map((n) => limiter.allow("10.0.0.1", n))).toEqual([true, false]);
  });

  it("spends at most an hourly share of the daily cap, so one burst can't block signups for a day", () => {
    const limiter = new SignupLimiter(1, 48);
    const burst = Array.from({ length: 10 }, (_, n) => limiter.allow(`10.0.${n}.1`, n));
    expect(burst.filter(Boolean)).toHaveLength(2);
    expect(limiter.allow("10.1.0.1", HOUR)).toBe(true);
  });
});
