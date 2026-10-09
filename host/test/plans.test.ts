import { describe, expect, it } from "vitest";
import type { HostConfig } from "../src/config.js";
import { limitsFor, planOf } from "../src/plans.js";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const base = { maxTtlSeconds: 604_800, tokenQuotaBytes: 250, maxFilesPerToken: 200 } as HostConfig;
const pro = { maxTtlSeconds: 7_776_000, quotaBytes: 5000, maxFiles: 2000 };

describe("plans", () => {
  it("treats a token without a plan, or with a lapsed one, as free", () => {
    expect(planOf({ id: "tok_a", hash: "h", createdAt: NOW }, NOW)).toBe("free");
    expect(planOf({ id: "tok_a", hash: "h", createdAt: NOW, plan: { name: "pro", until: NOW } }, NOW)).toBe("free");
    expect(planOf({ id: "tok_a", hash: "h", createdAt: NOW, plan: { name: "pro", until: NOW + 1 } }, NOW)).toBe("pro");
  });

  it("takes free limits from the host config and Pro limits from its pro section", () => {
    expect(limitsFor({ ...base, pro }, "free")).toEqual({ maxTtlSeconds: 604_800, quotaBytes: 250, maxFiles: 200 });
    expect(limitsFor({ ...base, pro }, "pro")).toEqual(pro);
  });

  it("falls back to free limits for Pro when the host defines no Pro plan", () => {
    expect(limitsFor(base, "pro")).toEqual(limitsFor(base, "free"));
  });
});
