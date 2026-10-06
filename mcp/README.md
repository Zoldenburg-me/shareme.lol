# share-me-mcp

An MCP server that turns files your AI agent generates into **expiring, unguessable links** your human can forward to anyone, instead of attaching the file. Links delete themselves when they expire.

Files are hosted at [shareme.lol](https://shareme.lol) by default, or on [your own host](https://shareme.lol/setup).

## Quick start

Claude Code:

```bash
claude mcp add share-me --scope user -- npx -y share-me-mcp@0.1.0
```

Codex CLI:

```bash
codex mcp add share-me -- npx -y share-me-mcp@0.1.0
```

Cursor (`~/.cursor/mcp.json`) or Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "share-me": { "command": "npx", "args": ["-y", "share-me-mcp@0.1.0"] } } }
```

That's it. On first start the server gets its own access token from the host and saves it to `~/.config/share-me/config.json` (readable only by you). Put files in `~/agent-output` and ask your agent to share them:

> Write a summary of today's test run to ~/agent-output/summary.md and share it as a link that lasts 2 hours.

Or paste this into your agent's chat and it sets itself up:

```
Set up share-me from https://shareme.lol/setup
```

## Tools

| Tool | Input | Result |
|---|---|---|
| `share_file` | `path` (absolute), `ttl_hours?`, `filename?` | Public URL, expiry time, link id |
| `list_links` | none | Your active links and when they expire |
| `revoke_link` | `id` | The link stops working and the file is deleted |

On shareme.lol links last 24 hours by default and at most 7 days. Each token has a storage quota.

## What it won't share

- Files outside the allowed folders (default `~/agent-output`). Symlinks are resolved and hard links refused.
- Credential-looking files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `.ssh/`, `.aws/`, …).
- Files containing private keys or AWS, GitHub, Anthropic, OpenAI, Slack, Google or share-me tokens.
- File types the host doesn't allow (executables and scripts never are).

These checks prevent mistakes and careless prompt injection. They are not a sandbox: an agent with shell access can copy files into an allowed folder.

## Commands

```bash
npx -y share-me-mcp@0.1.0 signup [host]
```

Gets a fresh token (default host `https://shareme.lol`).

```bash
npx -y share-me-mcp@0.1.0 login <host>
```

Saves a token someone gave you. It prompts without echoing and checks the token first.

## Configuration

All optional. Environment variables override the saved login.

| Variable | Default | |
|---|---|---|
| `SHARE_HOST_URL` | `https://shareme.lol` | Host to sign up at or use. https unless localhost |
| `SHARE_API_TOKEN` | saved login | Token for the host |
| `SHARE_ALLOWED_DIRS` | `~/agent-output` | Absolute folders agents may share from, separated by `:` (`;` on Windows) |
| `SHARE_DEFAULT_TTL_HOURS` | `24` | Link lifetime when the agent doesn't ask for one |
| `SHARE_MAX_FILE_MB` | `100` | Checked before uploading |

## License

MIT
