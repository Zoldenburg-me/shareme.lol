import { describe, expect, it } from "vitest";
import { MARKDOWN_RENDER_MAX_BYTES, isRenderableMarkdown, renderMarkdownPage } from "../src/markdownView.js";

describe("renderMarkdownPage", () => {
  it("renders headings, emphasis, tables and code as HTML", () => {
    const page = renderMarkdownPage("# Title\n\n**bold** `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", "notes.md");
    expect(page).toContain("<h1>Title</h1>");
    expect(page).toContain("<strong>bold</strong>");
    expect(page).toContain("<code>code</code>");
    expect(page).toContain("<table>");
  });

  it("escapes raw HTML in the markdown instead of passing it through", () => {
    const page = renderMarkdownPage('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">', "x.md");
    expect(page).not.toContain("<script>alert");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("drops javascript: links", () => {
    const page = renderMarkdownPage("[click](javascript:alert(1))", "x.md");
    expect(page).not.toContain('href="javascript:');
  });

  it("shows a small share-me banner linking home, next to View raw", () => {
    const page = renderMarkdownPage("hi", "notes.md");
    expect(page).toContain('<a href="?raw=1">View raw</a>');
    expect(page).toMatch(/<a class="cta" href="\/">Shared with <b>share-me<\/b> · Get it for your agent →<\/a>/);
  });

  it("escapes the filename in the title and header", () => {
    const page = renderMarkdownPage("hi", "<b>evil</b>.md");
    expect(page).toContain("<title>&lt;b&gt;evil&lt;/b&gt;.md</title>");
    expect(page).not.toContain("<b>evil</b>");
  });

  it("links to the raw source", () => {
    expect(renderMarkdownPage("hi", "x.md")).toContain('href="?raw=1"');
  });
});

describe("isRenderableMarkdown", () => {
  it("matches markdown under the render limit only", () => {
    expect(isRenderableMarkdown("text/markdown; charset=utf-8", 10)).toBe(true);
    expect(isRenderableMarkdown("text/markdown; charset=utf-8", MARKDOWN_RENDER_MAX_BYTES + 1)).toBe(false);
    expect(isRenderableMarkdown("text/plain; charset=utf-8", 10)).toBe(false);
  });
});
