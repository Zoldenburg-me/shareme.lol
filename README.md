# share-me

Let AI agents turn locally generated files into **expiring, unguessable links** that their human can forward to anyone, without attaching the file as a document.

```
agent ──share_file(path)──▶ share-me-mcp (your machine)
                               │  allowlist check, then upload + bearer token
                               ▼
                         share-host (Akash Network)
                               │  stores file, auto-deletes at expiry
                               ▼
               https://shareme.lol/f/<128-bit id>/report.html
```

| Package | Runs on | What it does |
|---|---|---|
| [`host/`](host) | Akash Network (Docker), behind a Cloudflare Tunnel | Accepts authenticated uploads, serves files at `/f/<id>/<name>`, deletes them when their TTL expires |
| [`mcp/`](mcp) | Your machine (stdio) | MCP server exposing `share_file`, `list_links`, `revoke_link` to agents |

## MCP tools

| Tool | Input | Result |
|---|---|---|
| `share_file` | `path` (absolute), `ttl_hours?`, `filename?` | Public URL, expiry, link id. Disallowed file types are refused before uploading |
| `list_links` | none | All active links |
| `revoke_link` | `id` | Link stops working and the file is deleted immediately |

## Security model

**Threat model:** the allowlist, denylist and secret scan stop agents from *accidentally* (or via a careless prompt injection) sharing the wrong file. They are **not** a sandbox. An agent that also has a shell can copy any file into an allowed dir, or read `SHARE_API_TOKEN` from the MCP config and call the host directly. If you run agents that may be fully hostile, run the MCP server as a separate OS user and keep its config `0600`.

- **Links** carry a random 128-bit id. Anyone who has the link can open it until it expires or is revoked.
- **Auto-delete:** each file has a TTL. The default is 24 h; the host caps it at `MAX_TTL_SECONDS` (default 7 days). A sweeper deletes expired files every minute, and expired links return 404 straight away.
- **Path allowlist:** the MCP server only shares files under `SHARE_ALLOWED_DIRS`. Symlinks are resolved and hard links are rejected. The file is opened once and its identity re-verified, then uploaded from that handle, so it can't be swapped after the check. Credential-looking paths (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `*.tfstate`, `.ssh/`, `.aws/`, `.git/`, `.config/`, …) are refused even inside an allowed dir.
- **Secret scan:** before upload, file contents are scanned for private keys and AWS, GitHub, Anthropic, OpenAI, Slack and Google API keys. A match blocks the share.
- **File types:** only allowlisted extensions can be shared (default list below, narrow it with `ALLOWED_EXTENSIONS`). The host checks each file's leading bytes against its extension, so a binary renamed to `report.pdf` is rejected. Text types must not contain NUL bytes. The host sets `Content-Type` from the extension and ignores the uploader's header. Executables, scripts and archives other than `.zip` are never served.
- **Storage quota:** the host refuses uploads with 507 once `MAX_TOTAL_MB` is used, so a full disk can't take it down.
- **Accounts:** with `OPEN_SIGNUP=1`, anyone can get a self-service token (`sm_…`). The host stores only its SHA-256 hash. A token can list and revoke only its own links and has a storage quota (`TOKEN_QUOTA_MB`). Signups, API calls, failed logins, uploads and downloads are rate-limited (429 with `Retry-After`); client IPs are kept in memory for at most an hour and never written to disk.
- **Admin token:** `SHARE_API_TOKEN` (compared in constant time) sees every link and can revoke any token with `DELETE /api/tokens/<id>`, which also deletes that token's files. A token can delete itself with `DELETE /api/tokens/me`. The MCP server refuses plain `http://` to a remote host.
- **Served files are untrusted:** responses carry `Content-Security-Policy: sandbox` (plus `frame-ancestors 'none'`), `nosniff`, `no-referrer`, `noindex` and `no-store`, so an agent-written HTML page can't run scripts on your share domain. Use a dedicated domain that hosts nothing else.
- **Akash caveats:** SDL env values are visible to the provider you lease from. A redeploy or a provider change can wipe the persistent volume, which kills live links early.

## Setup

### 1. Generate a token

```bash
openssl rand -base64 48
```

### 2. Build and push the host image

Akash providers run `linux/amd64`, so the image must be built for that platform, even on an Apple Silicon Mac.

**Easiest, with no local Docker:** push this repo to GitHub. The [`host-image`](.github/workflows/host-image.yml) workflow runs the tests, builds the amd64 image and pushes it to `ghcr.io/zoldenburg-me/share-me-host:latest`. Then, in GitHub, open **Packages → share-me-host → Package settings** and set the visibility to **Public** so Akash can pull it.

**Or build locally** with Docker Desktop or OrbStack installed. Log in with a GitHub token that has `write:packages`, and use your GitHub username in lowercase:

```bash
docker buildx build --platform linux/amd64 -f host/Dockerfile -t ghcr.io/zoldenburg-me/share-me-host:0.1.0 --push .
```

### 3. Deploy on Akash

Traffic reaches the host only through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/). A `cloudflared` sidecar in the same deployment dials out to Cloudflare, so `share-host` has no public port. You get end-to-end TLS, and the provider's ingress and IP are never exposed.

**Create the tunnel** (once). You need the `cf` CLI logged in to the account that holds the `shareme.lol` zone:

```bash
cf tunnels create --config-src cloudflare --name share-me
```

Note the tunnel `id` it prints. Then point the tunnel's hostnames at the sidecar's view of the host ([`host/tunnel-config.json`](host/tunnel-config.json)):

```bash
cf tunnels config update <TUNNEL_ID> --body "$(cat host/tunnel-config.json)"
```

Route DNS to the tunnel. This replaces any existing `shareme.lol` record; delete the old one first if it exists:

```bash
cf dns records create -z shareme.lol --body '{"type":"CNAME","name":"shareme.lol","content":"<TUNNEL_ID>.cfargotunnel.com","proxied":true}'
```

```bash
cf dns records create -z shareme.lol --body '{"type":"CNAME","name":"www","content":"<TUNNEL_ID>.cfargotunnel.com","proxied":true}'
```

Print the connector token:

```bash
cf tunnels token get <TUNNEL_ID>
```

**Deploy.** Edit [`host/deploy.yaml`](host/deploy.yaml): set the image, `SHARE_API_TOKEN`, `PUBLIC_BASE_URL` and `TUNNEL_TOKEN` (the output above). Don't commit the real values. Then deploy it through [Akash Console](https://console.akash.network) by pasting the SDL and accepting a bid. Set the zone's SSL mode to *Full* or *Full (strict)*; *Flexible* is no longer needed. Uploads go through Cloudflare, which rejects request bodies over 100 MB on free and pro plans, so the SDL sets `MAX_FILE_MB=95`.

Check it works:

```bash
curl https://shareme.lol/healthz
```

**Redeploy.** Every push to `main` that touches `host/` or `site/` builds `ghcr.io/zoldenburg-me/share-me-host:sha-<commit>`. Once that build finishes, switch the running deployment to it. This keeps the lease and the `/data` volume and needs `AKASH_CONSOLE_API_KEY` in `.env`:

```bash
node scripts/akash.mjs update
```

### 4. Register the MCP server with your agent

Easiest: paste this into your agent's chat and let it follow the guide the host serves at `/setup`:

```
Set up share-me from https://shareme.lol/setup
```

Or register it by hand. There is no signup form: on its first start the MCP server asks the host for its own access token (`POST /api/tokens`) and saves it to `~/.config/share-me/config.json` (mode 600). Each machine, or each agent with its own `HOME`, gets a separate token.

```bash
claude mcp add share-me --scope user -- npx -y share-me-mcp
```

```bash
codex mcp add share-me -- npx -y share-me-mcp
```

For Cursor (`~/.cursor/mcp.json`) or Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "share-me": { "command": "npx", "args": ["-y", "share-me-mcp"] } } }
```

Agents share files from `~/agent-output` by default (created automatically). Env vars still work and override the saved login.

Other ways to get a token, in a terminal:

```bash
npx -y share-me-mcp signup https://shareme.lol
```

```bash
npx -y share-me-mcp login https://shareme.lol
```

`signup` gets a fresh self-service token; `login` saves a token someone gave you (it prompts without echoing and checks it first).

> The `npx` commands work once the `mcp/` package is published to npm as `share-me-mcp` (`npm publish -w mcp`). Until then, use `node /path/to/share-me/mcp/dist/index.js` in place of `npx -y share-me-mcp`.

## Configuration

**Host** (env in `deploy.yaml`)

| Var | Default | |
|---|---|---|
| `SHARE_API_TOKEN` | required | ≥ 32 chars |
| `PUBLIC_BASE_URL` | required | Base for returned links |
| `DEFAULT_TTL_SECONDS` | `86400` | Used when the agent doesn't pass `ttl_hours` |
| `MAX_TTL_SECONDS` | `604800` | Hard cap on any TTL |
| `MAX_FILE_MB` | `100` | Upload size limit. Keep it under Cloudflare's 100 MB request limit (the SDL uses `95`) |
| `MAX_TOTAL_MB` | `9216` | Storage quota across all live files. Keep it below the volume size |
| `OPEN_SIGNUP` | off | `1` lets anyone get a self-service token at `POST /api/tokens` |
| `TOKEN_QUOTA_MB` | `250` | Storage each self-service token may use at once |
| `SIGNUPS_PER_IP_PER_HOUR` / `SIGNUPS_PER_DAY` | `5` / `500` | Signup throttle |
| `TRUST_CF_CONNECTING_IP` | off | `1` takes the client IP from Cloudflare's `CF-Connecting-IP`; only when every request comes through Cloudflare |
| `API_REQUESTS_PER_IP_PER_MINUTE` | `120` | Requests to `/api` per client IP; over it the host answers 429 with `Retry-After` |
| `AUTH_FAILURES_PER_IP_PER_HOUR` | `30` | Wrong tokens per client IP before that IP is locked out of `/api` for the rest of the hour |
| `UPLOADS_PER_TOKEN_PER_HOUR` | `60` | Uploads per self-service token (the admin token is exempt) |
| `DOWNLOADS_PER_IP_PER_MINUTE` | `300` | Link downloads per client IP |
| `ALLOWED_EXTENSIONS` | all known types | Comma- or space-separated subset, e.g. `pdf,png,md`. Known types: `pdf html htm md txt log csv json xml docx xlsx pptx zip png jpg jpeg gif webp svg mp4 webm mp3 wav`. To add a type, add it to [`host/src/fileTypes.ts`](host/src/fileTypes.ts) with its content type and signature |
| `SWEEP_INTERVAL_SECONDS` | `60` | How often expired files are deleted |
| `DATA_DIR` / `PORT` | `/data` / `8080` | |

**MCP** (see [`.env.example`](.env.example))

| Var | Default | |
|---|---|---|
| `SHARE_HOST_URL` | from `login` | https, unless it's localhost |
| `SHARE_API_TOKEN` | from `signup`/`login` | A self-service token or the host's admin token |
| `SHARE_ALLOWED_DIRS` | `~/agent-output` | Absolute dirs, separated by `:` (`;` on Windows) |
| `SHARE_DEFAULT_TTL_HOURS` | `24` | |
| `SHARE_MAX_FILE_MB` | `100` | Checked locally before uploading |
| `SHARE_ALLOW_INSECURE_HTTP` | unset | `1` allows plain http to a remote host (not recommended) |

## Development

```bash
npm test
```

```bash
npm run test:coverage
```

```bash
npm run typecheck
```

To run the host locally:

```bash
SHARE_API_TOKEN=$(openssl rand -hex 32) PUBLIC_BASE_URL=http://localhost:8080 DATA_DIR=./.data npm start -w host
```

(Run `npm run build` first.)
