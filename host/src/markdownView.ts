import MarkdownIt from "markdown-it";

/** Larger markdown files are served raw: rendering buffers the whole file in memory. */
export const MARKDOWN_RENDER_MAX_BYTES = 2 * 1024 * 1024;

// html: false escapes raw HTML in the source; markdown-it's link validation already drops javascript:/vbscript:/file: URLs.
// The page is still served under the sandbox CSP, so even a renderer bug can't run script.
const md = new MarkdownIt({ html: false, linkify: true });

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export const isRenderableMarkdown = (contentType: string, size: number): boolean =>
  contentType.startsWith("text/markdown") && size <= MARKDOWN_RENDER_MAX_BYTES;

// System fonts only: the download CSP (default-src 'none') blocks web fonts.
const STYLE = `
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--code:#f6f8fa;--link:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#3d444d;--code:#151b23;--link:#4493f8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
header{display:flex;justify-content:space-between;gap:1rem;align-items:center;padding:.6rem 1rem;border-bottom:1px solid var(--border);color:var(--muted);font-size:.875rem}
header{flex-wrap:wrap}
header span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
header nav{display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
.cta{color:var(--muted);text-decoration:none}
.cta b{color:var(--fg);font-weight:600}
.cta:hover{color:var(--link)}
main{max-width:860px;margin:0 auto;padding:1.5rem 1rem 4rem;overflow-wrap:break-word}
a{color:var(--link)}
h1,h2{border-bottom:1px solid var(--border);padding-bottom:.3em}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.875em;background:var(--code);border-radius:6px}
code{padding:.15em .35em}
pre{padding:1rem;overflow-x:auto}
pre code{padding:0;background:none}
blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:.25em solid var(--border)}
table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%}
th,td{border:1px solid var(--border);padding:.4em .8em}
img{max-width:100%}
hr{border:0;border-top:1px solid var(--border)}
`;

/** A standalone HTML page showing the rendered markdown, with a link back to the raw file. */
export function renderMarkdownPage(source: string, filename: string): string {
  const name = escapeHtml(filename);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>${STYLE}</style>
</head>
<body>
<header><span>${name}</span><nav><a href="?raw=1">View raw</a><a class="cta" href="/">Shared with <b>share-me</b> · Get it for your agent →</a></nav></header>
<main>
${md.render(source)}</main>
</body>
</html>
`;
}
