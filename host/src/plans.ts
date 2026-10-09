import type { HostConfig } from "./config.js";
import type { TokenRecord } from "./tokens.js";

export type PlanName = "free" | "pro";

/** What one token may do at once: how long a link can live, and how much it may store. */
export interface PlanLimits {
  readonly maxTtlSeconds: number;
  readonly quotaBytes: number;
  readonly maxFiles: number;
}

/** The admin token (SHARE_API_TOKEN) sees everything; a self-service token sees only its own files. */
export type Principal =
  | { readonly kind: "admin"; readonly limits: PlanLimits }
  | { readonly kind: "user"; readonly id: string; readonly plan: PlanName; readonly limits: PlanLimits };

export function planOf(record: TokenRecord, now: number): PlanName {
  return record.plan && record.plan.until > now ? "pro" : "free";
}

export function limitsFor(config: HostConfig, plan: PlanName): PlanLimits {
  const free = { maxTtlSeconds: config.maxTtlSeconds, quotaBytes: config.tokenQuotaBytes, maxFiles: config.maxFilesPerToken };
  return plan === "pro" ? (config.pro ?? free) : free;
}
