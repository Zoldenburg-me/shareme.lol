import { describe, expect, it } from "vitest";
import { renderSetupGuide } from "../src/setupGuide.js";

describe("renderSetupGuide", () => {
  const guide = renderSetupGuide("https://share.acme.dev");

  it("registers every client with the zero-config command", () => {
    expect(guide).toContain("claude mcp add share-me --scope user -- npx -y share-me-mcp");
    expect(guide).toContain("codex mcp add share-me -- npx -y share-me-mcp");
    expect(guide).toContain('"args": ["-y", "share-me-mcp"]');
  });

  it("explains that the first run gets its own token from this host", () => {
    expect(guide).toMatch(/first start.*own access token/is);
    expect(guide).toContain("npx -y share-me-mcp signup https://share.acme.dev");
    expect(guide).toContain("npx -y share-me-mcp login https://share.acme.dev");
  });

  it("keeps tokens out of the agent chat", () => {
    expect(guide).toMatch(/never paste .*token.* into (this|the) chat/i);
  });

  it("documents the three tools and the per-token quota", () => {
    for (const tool of ["share_file", "list_links", "revoke_link"]) expect(guide).toContain(tool);
    expect(guide).toMatch(/quota/i);
  });
});
