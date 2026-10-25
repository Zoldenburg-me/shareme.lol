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
    const limiter = new SignupLimiter(2, 1000);
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
    expect(networkOf("64:ff9b::192.0.2.33")).toBe("192.0.2.33");
    expect(networkOf("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe("192.0.2.45");
    expect(networkOf("2001:0:4136:e378:8000:63bf:3fff:fdd2", 3)).toBe("192.0.2.45");
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

  it("keeps half of each hour's share for new networks, so a few networks filling it at hh:00 can't lock others out", () => {
    const limiter = new SignupLimiter(5, 500); // the defaults: 21 an hour, 10 of them reserved
    const attacker = ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4", "192.0.2.5"];
    // Network by network is the attacker's best order: the last networks' first signups still count as new.
    const flood = (at: number) => attacker.flatMap((ip) => Array.from({ length: 5 }, () => limiter.allow(ip, at))).filter(Boolean).length;
    const freshIn = (h: number) => Array.from({ length: 12 }, (_, n) => limiter.allow(`10.${h}.${n}.1`, h * HOUR + 60_000)).filter(Boolean).length;
    expect(flood(0)).toBe(13);
    expect(freshIn(0)).toBe(8);
    for (let h = 1; h < 23; h++) { // hour 23 meets the daily cap: 24 x 21 > 500
      expect(flood(h * HOUR)).toBe(11);
      expect(freshIn(h)).toBe(10);
    }
  });

  it("lets new networks use the open part too, and treats a network as new again after 24 quiet hours", () => {
    const limiter = new SignupLimiter(5, 96); // 4 an hour, 2 reserved
    expect(limiter.allow("192.0.2.1", 0)).toBe(true);
    expect(limiter.allow("192.0.2.1", HOUR)).toBe(true);
    expect(limiter.allow("192.0.2.1", HOUR + 1)).toBe(true);
    expect(limiter.allow("192.0.2.1", HOUR + 2)).toBe(false);
    expect([3, 4, 5].map((n) => limiter.allow(`10.0.0.${n}`, HOUR + n))).toEqual([true, true, false]);
    expect([0, 1].map((n) => limiter.allow("10.0.0.9", 2 * DAY + n))).toEqual([true, true]);
    expect(limiter.allow("192.0.2.1", 2 * DAY + 2)).toBe(true);
  });

  it("keys Teredo clients by their own IPv4, not by their shared Teredo server", () => {
    const limiter = new SignupLimiter(1, 1000);
    expect(limiter.allow("2001:0:4136:e378:8000:63bf:3fff:fdd2", 0)).toBe(true); // 192.0.2.45
    expect(limiter.allow("2001:0:4136:e378:8000:63bf:3fff:fdd3", 1)).toBe(true); // 192.0.2.44
    expect(limiter.allow("192.0.2.45", 2)).toBe(false);
  });

  it("counts a clock step back as no time passing", () => {
    const limiter = new SignupLimiter(5, 96);
    expect(limiter.allow("10.0.0.1", HOUR)).toBe(true);
    expect([1, 2, 3].map((n) => limiter.allow(`10.0.1.${n}`, HOUR - 10 + n))).toEqual([true, true, true]);
    expect(limiter.allow("10.0.1.9", HOUR - 1)).toBe(false);
  });

  it("counts a /48 that signed up recently as returning, even from a new /64", () => {
    const limiter = new SignupLimiter(5, 96);
    expect(limiter.allow("2001:db8:1:1::1", 0)).toBe(true);
    expect([1, 2, 3].map((n) => limiter.allow(`2001:db8:1:${n + 1}::1`, HOUR + n))).toEqual([true, true, false]);
    expect(limiter.allow("2001:db8:2:1::1", HOUR + 4)).toBe(true);
  });
});
