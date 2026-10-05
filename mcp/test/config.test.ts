import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpConfig, normalizeHostUrl } from "../src/config.js";

const HOME = "/home/agent";
const TOKEN = "k".repeat(32);
const base = { SHARE_HOST_URL: "https://share.example.com/", SHARE_API_TOKEN: TOKEN, SHARE_ALLOWED_DIRS: "/tmp/out" };

describe("loadMcpConfig", () => {
  it("parses env values and applies defaults", () => {
    expect(loadMcpConfig(base, undefined, HOME)).toEqual({
      hostUrl: "https://share.example.com",
      apiToken: TOKEN,
      allowedDirs: ["/tmp/out"],
      defaultTtlHours: 24,
      maxFileBytes: 100 * 1024 * 1024,
    });
  });

  it("uses the saved login when env does not set host or token", () => {
    const config = loadMcpConfig({}, { host: "https://saved.example.com", token: "saved-token" }, HOME);
    expect(config.hostUrl).toBe("https://saved.example.com");
    expect(config.apiToken).toBe("saved-token");
  });

  it("lets env override the saved login", () => {
    const config = loadMcpConfig(base, { host: "https://saved.example.com", token: "saved-token" }, HOME);
    expect(config.hostUrl).toBe("https://share.example.com");
    expect(config.apiToken).toBe(TOKEN);
  });

  it("defaults the shareable folder to ~/agent-output", () => {
    const config = loadMcpConfig({ ...base, SHARE_ALLOWED_DIRS: "" }, undefined, HOME);
    expect(config.allowedDirs).toEqual([join(HOME, "agent-output")]);
  });

  it("splits SHARE_ALLOWED_DIRS on the platform delimiter and rejects relative entries", () => {
    expect(loadMcpConfig({ ...base, SHARE_ALLOWED_DIRS: ["/a", "/b", ""].join(delimiter) }, undefined, HOME).allowedDirs).toEqual(["/a", "/b"]);
    expect(() => loadMcpConfig({ ...base, SHARE_ALLOWED_DIRS: "relative/dir" }, undefined, HOME)).toThrow(/absolute/);
  });

  it("tells the human to run login when host or token are missing", () => {
    expect(() => loadMcpConfig({ SHARE_API_TOKEN: TOKEN }, undefined, HOME)).toThrow(/share-me-mcp login/);
    expect(() => loadMcpConfig({ SHARE_HOST_URL: "https://a.b" }, undefined, HOME)).toThrow(/share-me-mcp login/);
  });

  it("rejects non-positive numbers", () => {
    expect(() => loadMcpConfig({ ...base, SHARE_DEFAULT_TTL_HOURS: "0" }, undefined, HOME)).toThrow(/SHARE_DEFAULT_TTL_HOURS/);
  });
});

describe("normalizeHostUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeHostUrl("https://share.example.com/")).toBe("https://share.example.com");
  });

  it("rejects non-http URLs", () => {
    expect(() => normalizeHostUrl("nope")).toThrow(/http/);
    expect(() => normalizeHostUrl("ftp://a.b")).toThrow(/http/);
  });

  it("refuses plain http to a remote host because the token would travel in cleartext", () => {
    expect(() => normalizeHostUrl("http://share.example.com")).toThrow(/https/);
    expect(normalizeHostUrl("http://share.example.com", true)).toBe("http://share.example.com");
    expect(normalizeHostUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeHostUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });
});
