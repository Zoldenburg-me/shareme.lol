import type { HostConfig } from "./config.js";
import { RateLimiter } from "./rateLimiter.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Per-process request limits; see HostConfig for what each one counts. */
export interface Limits {
  readonly api: RateLimiter;
  readonly authFailures: RateLimiter;
  readonly uploads: RateLimiter;
  readonly downloads: RateLimiter;
  readonly shortLinkMisses: RateLimiter;
}

export function createLimits(config: HostConfig): Limits {
  return {
    api: new RateLimiter(config.apiRequestsPerIpPerMinute, MINUTE_MS),
    authFailures: new RateLimiter(config.authFailuresPerIpPerHour, HOUR_MS),
    uploads: new RateLimiter(config.uploadsPerTokenPerHour, HOUR_MS),
    downloads: new RateLimiter(config.downloadsPerIpPerMinute, MINUTE_MS),
    shortLinkMisses: new RateLimiter(config.shortLinkMissesPerIpPerHour, HOUR_MS),
  };
}
