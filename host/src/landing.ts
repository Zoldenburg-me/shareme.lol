import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Shown at / when no landing page file is available. */
export const FALLBACK_LANDING = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>share-me host</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#000;color:#efe6df;font:16px/1.5 system-ui,sans-serif}main{max-width:36rem}code{color:#ec9117}</style>
</head><body><main><h1>share-me host is running</h1>
<p>Shared files are served at <code>/f/&lt;id&gt;/&lt;name&gt;</code>. Health check: <code>/healthz</code>.</p></main></body></html>`;

/** The landing page is authored as a fragment (title, styles, body content); give it a document shell. */
export function wrapPage(fragment: string): string {
  if (/^\s*<!doctype/i.test(fragment)) return fragment;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head>' +
    `<body>${fragment}</body></html>`
  );
}

/** The page is authored for shareme.lol; a self-hosted copy shows its own URL instead. */
const PLACEHOLDER_ORIGIN = /https:\/\/shareme\.lol|shareme\.lol/g;

export async function loadLandingPage(path: string, baseUrl: string): Promise<string> {
  try {
    const html = (await readFile(path, "utf8")).replace(PLACEHOLDER_ORIGIN, (match) =>
      match.startsWith("https://") ? baseUrl : new URL(baseUrl).host,
    );
    return wrapPage(html);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    console.warn(`[share-host] no landing page at ${path}; serving the status page at /`);
    return FALLBACK_LANDING;
  }
}

/** The imprint, privacy policy and terms name the operator of shareme.lol; a self-hosted copy publishes its own. */
const LEGAL_HOST = "shareme.lol";

export interface LegalPages {
  readonly imprint: string;
  readonly privacy: string;
  readonly terms: string;
}

/** Legal pages are required on shareme.lol, so a missing file there fails startup. */
export async function loadLegalPages(siteDir: string, baseUrl: string): Promise<LegalPages | undefined> {
  if (new URL(baseUrl).host !== LEGAL_HOST) return undefined;
  const [imprint, privacy, terms] = await Promise.all(
    ["imprint.html", "privacy.html", "terms.html"].map((name) => readFile(join(siteDir, name), "utf8")),
  );
  return { imprint: wrapPage(imprint), privacy: wrapPage(privacy), terms: wrapPage(terms) };
}
