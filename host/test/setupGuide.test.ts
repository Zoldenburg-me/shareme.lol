import { describe, expect, it } from "vitest";
import { renderSetupGuide } from "../src/setupGuide.js";

describe("renderSetupGuide", () => {
  const guide = renderSetupGuide("https://share.acme.dev");

  it("points the login and every client at this host", () => {
    expect(guide).toContain("npx -y share-me-mcp login https://share.acme.dev");
    expect(guide).toContain("claude mcp add share-me --scope user -- npx -y share-me-mcp");
    expect(guide).toContain("codex mcp add share-me -- npx -y share-me-mcp");
    expect(guide).toContain('"args": ["-y", "share-me-mcp"]');
  });

  it("keeps the token out of the agent chat", () => {
    expect(guide).toMatch(/own terminal/);
    expect(guide).toMatch(/not .*paste .*token .*chat/i);
  });

  it("documents the three tools", () => {
    for (const tool of ["share_file", "list_links", "revoke_link"]) expect(guide).toContain(tool);
  });
});
