import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { FILE_TYPES } from "../src/fileTypes.js";

const TOKEN = "x".repeat(32);

describe("loadConfig", () => {
  it("applies defaults when only required vars are set", () => {
    const config = loadConfig({ SHARE_API_TOKEN: TOKEN, PUBLIC_BASE_URL: "https://share.example.com/" });

    expect(config).toMatchObject({
      apiToken: TOKEN,
      publicBaseUrl: "https://share.example.com",
      dataDir: "/data",
      port: 8080,
      defaultTtlSeconds: 86_400,
      maxTtlSeconds: 604_800,
      maxFileBytes: 100 * 1024 * 1024,
      landingPage: "site/index.html",
      maxTotalBytes: 9 * 1024 * 1024 * 1024,
      allowedExtensions: Object.keys(FILE_TYPES).sort(),
      openSignup: false,
      tokenQuotaBytes: 250 * 1024 * 1024,
      signupsPerIpPerHour: 5,
      signupsPerDay: 500,
      trustCfConnectingIp: false,
      apiRequestsPerIpPerMinute: 120,
      authFailuresPerIpPerHour: 30,
      uploadsPerTokenPerHour: 60,
      downloadsPerIpPerMinute: 300,
      shortLinkMissesPerIpPerHour: 60,
      maxFilesPerToken: 200,
      concurrentUploadsPerToken: 2,
      minUploadBytesPerSecond: 1024,
      uploadPaceWindowMs: 10_000,
    });
  });

  it("throws when the API token is missing or too short", () => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: "https://a.b" })).toThrow(/SHARE_API_TOKEN/);
    expect(() => loadConfig({ SHARE_API_TOKEN: "short", PUBLIC_BASE_URL: "https://a.b" })).toThrow(/at least 32/);
  });

  it("throws when PUBLIC_BASE_URL is not an http(s) URL", () => {
    expect(() => loadConfig({ SHARE_API_TOKEN: TOKEN })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => loadConfig({ SHARE_API_TOKEN: TOKEN, PUBLIC_BASE_URL: "ftp://a.b" })).toThrow(/PUBLIC_BASE_URL/);
  });

  it("restricts uploads to ALLOWED_EXTENSIONS when set", () => {
    const config = loadConfig({ SHARE_API_TOKEN: TOKEN, PUBLIC_BASE_URL: "https://a.b", ALLOWED_EXTENSIONS: "pdf,png" });
    expect(config.allowedExtensions).toEqual(["pdf", "png"]);
    expect(() => loadConfig({ SHARE_API_TOKEN: TOKEN, PUBLIC_BASE_URL: "https://a.b", ALLOWED_EXTENSIONS: "exe" })).toThrow(/ALLOWED_EXTENSIONS/);
  });

  it("turns on open signup and Cloudflare client IPs only when asked", () => {
    const config = loadConfig({ SHARE_API_TOKEN: TOKEN, PUBLIC_BASE_URL: "https://a.b", OPEN_SIGNUP: "1", TRUST_CF_CONNECTING_IP: "1", TOKEN_QUOTA_MB: "10" });
    expect(config).toMatchObject({ openSignup: true, trustCfConnectingIp: true, tokenQuotaBytes: 10 * 1024 * 1024 });
  });

  it("throws on non-positive numeric settings", () => {
    const env = { SHARE_API_TOKEN: TOKEN, PUBLIC_BASE_URL: "https://a.b", MAX_TTL_SECONDS: "-1" };
    expect(() => loadConfig(env)).toThrow(/MAX_TTL_SECONDS/);
  });

  it("throws when the default TTL exceeds the max TTL", () => {
    const env = { SHARE_API_TOKEN: TOKEN, PUBLIC_BASE_URL: "https://a.b", DEFAULT_TTL_SECONDS: "100", MAX_TTL_SECONDS: "10" };
    expect(() => loadConfig(env)).toThrow(/DEFAULT_TTL_SECONDS/);
  });
});
