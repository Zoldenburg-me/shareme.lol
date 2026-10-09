/** First-party 404 pages: one for share links (/f/<id>) and one for any other unknown page. */

// Static pages: no scripts, no outside requests; fonts come from this host when present.
export const NOT_FOUND_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "no-store",
} as const;

interface NotFoundCopy {
  readonly label: string;
  readonly title: string;
  readonly emphasis: string;
  readonly text: string;
}

const STYLE = `
@font-face{font-family:"DM Sans";font-weight:300 500;font-display:swap;src:url(/fonts/dm-sans.woff2) format("woff2")}
@font-face{font-family:"Instrument Serif";font-style:italic;font-display:swap;src:url(/fonts/instrument-serif-italic.woff2) format("woff2")}
:root{--bg:#000;--ink:#efe6df;--ink-soft:#918a85;--accent:#ec9117;--accent-deep:#ba6900;--on-accent:#242323;
--sans:"DM Sans",system-ui,sans-serif;--serif:"Instrument Serif",Georgia,serif}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font:400 16px/1.4 var(--sans)}
header,main{width:100%;max-width:760px;margin:0 auto;padding:22px 40px}
main{flex:1;display:flex;flex-direction:column;justify-content:center;padding-bottom:12vh}
.wordmark{display:inline-flex;align-items:baseline;gap:.14em;font:500 20px/1 var(--sans);letter-spacing:-.02em;color:var(--ink);text-decoration:none}
.wordmark i{display:inline-block;width:.22em;height:.22em;background:var(--accent)}
.code{font:400 13px/1 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin:0 0 20px}
h1{margin:0 0 24px;font-weight:400}
.display{display:block;font:400 clamp(36px,6vw,58px)/1 var(--sans)}
.emphasis{display:block;font:italic 400 clamp(38px,6.3vw,61px)/1.3 var(--serif);color:var(--ink-soft)}
p{font:400 18px/1.4 var(--sans);color:var(--ink-soft);max-width:44ch;margin:0 0 32px}
.btn{align-self:flex-start;background:var(--accent);color:var(--on-accent);font:400 14px/1.2 var(--sans);padding:12px 16px;border-radius:12px;text-decoration:none}
.btn:hover{background:linear-gradient(var(--accent),var(--accent-deep))}
@media (max-width:600px){header,main{padding-inline:16px}p{font-size:17px}}
`;

function render(copy: NotFoundCopy): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${copy.label} · share-me</title>
<style>${STYLE}</style>
</head>
<body>
<header><a class="wordmark" href="/">share-me<i aria-hidden="true"></i></a></header>
<main>
<p class="code">404 · ${copy.label}</p>
<h1><span class="display">${copy.title}</span><span class="emphasis">${copy.emphasis}</span></h1>
<p>${copy.text}</p>
<a class="btn" href="/">Go to share-me</a>
</main>
</body>
</html>
`;
}

/** At /f/<id> when the link has expired, was revoked, or never existed. */
export const LINK_GONE_PAGE = render({
  label: "Link not found",
  title: "This link has expired",
  emphasis: "or never existed",
  text: "Shared files are deleted as soon as their link expires or the sender revokes it. If you still need the file, ask whoever sent you the link for a new one.",
});

/** At any other address the site doesn't have. */
export const PAGE_NOT_FOUND_PAGE = render({
  label: "Page not found",
  title: "Nothing lives here",
  emphasis: "not even a link",
  text: "This page doesn't exist. Check the address for a typo, or start from the home page.",
});
