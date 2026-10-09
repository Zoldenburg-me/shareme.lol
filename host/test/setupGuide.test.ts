import { describe, expect, it } from "vitest";
import { renderSetupGuide } from "../src/setupGuide.js";

describe("renderSetupGuide", () => {
  const guide = renderSetupGuide("https://share.acme.dev");
  const hosted = renderSetupGuide("https://shareme.lol");

  it("registers every client with a pinned package version", () => {
    for (const g of [guide, hosted]) {
      expect(g).toContain("claude mcp add share-me --scope user -- npx -y share-me-mcp@0.1.0");
      expect(g).toContain("codex mcp add share-me -- npx -y share-me-mcp@0.1.0");
      expect(g).toContain('"args": ["-y", "share-me-mcp@0.1.0"]');
      expect(g).not.toMatch(/share-me-mcp(?![@\w-])/);
    }
  });

  it("on shareme.lol, explains that the first run gets its own token", () => {
    expect(hosted).toMatch(/first start.*own access token/is);
    expect(hosted).toContain("npx -y share-me-mcp@0.1.0 signup https://shareme.lol");
  });

  it("on a self-hosted copy, signs up at that host before registering", () => {
    const signup = guide.indexOf("npx -y share-me-mcp@0.1.0 signup https://share.acme.dev");
    expect(signup).toBeGreaterThan(-1);
    expect(signup).toBeLessThan(guide.indexOf("claude mcp add"));
    expect(guide).toContain("npx -y share-me-mcp@0.1.0 login https://share.acme.dev");
  });

  it("offers both the hosted and the self-hosted path", () => {
    expect(hosted).toContain("https://github.com/Zoldenburg-me/shareme.lol#setup");
    expect(hosted).toContain("https://shareme.lol/terms");
    expect(guide).not.toContain("https://shareme.lol/terms");
  });

  it("is honest that expiry deletes only the hosted copy", () => {
    expect(guide).toMatch(/anyone who opens the link can keep a copy/i);
  });

  it("keeps tokens out of the agent chat", () => {
    expect(guide).toMatch(/never paste .*token.* into (this|the) chat/i);
  });

  it("documents the three tools and the per-token quota", () => {
    for (const tool of ["share_file", "list_links", "extend_link", "revoke_link"]) expect(guide).toContain(tool);
    expect(guide).toMatch(/quota/i);
  });
});
