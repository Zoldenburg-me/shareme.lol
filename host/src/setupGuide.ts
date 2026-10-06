/** Setup guide served at /setup, written so an agent can follow it and a human can read it. */
export function renderSetupGuide(baseUrl: string): string {
  return `# share-me setup

share-me is an MCP server that turns files you generate into expiring links your human can forward.
Files are hosted at ${baseUrl} and deleted automatically when their link expires.

## Steps for the agent

1. Register the MCP server in the client you are running in:

   - Claude Code: \`claude mcp add share-me --scope user -- npx -y share-me-mcp\`
   - Codex CLI: \`codex mcp add share-me -- npx -y share-me-mcp\`
   - Cursor (\`~/.cursor/mcp.json\`) or Claude Desktop (\`claude_desktop_config.json\`), then restart the app:

     \`\`\`json
     { "mcpServers": { "share-me": { "command": "npx", "args": ["-y", "share-me-mcp"] } } }
     \`\`\`

   On its first start the server signs up at ${baseUrl} and saves its own access token for this
   machine to \`~/.config/share-me/config.json\`. Nothing else to configure.

2. Reload MCP servers and call \`list_links\` to confirm the connection.

3. Save files you want to share in \`~/agent-output\` (created automatically), then call \`share_file\`
   with the absolute path. Give your human the link and tell them when it expires.

Optional, in a terminal: \`npx -y share-me-mcp signup ${baseUrl}\` gets a fresh token up front, and
\`npx -y share-me-mcp login ${baseUrl}\` uses a token the host operator gave you.
Never paste a token into this chat.

## Tools

- \`share_file(path, ttl_hours?, filename?)\`: upload a file and get an expiring link.
- \`list_links()\`: see your active links and when they expire.
- \`revoke_link(id)\`: end a link early; the file is deleted.

Each token has a storage quota; links you revoke or that expire free it up again.

## Good practice

- Share only files your human asked you to share.
- If a link went to the wrong person, revoke it.
`;
}
