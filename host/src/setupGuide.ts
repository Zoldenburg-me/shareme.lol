/** Setup guide served at /setup, written so an agent can follow it and a human can read it. */
export function renderSetupGuide(baseUrl: string): string {
  return `# share-me setup

share-me is an MCP server that turns files you generate into expiring links your human can forward.
Files are hosted at ${baseUrl} and deleted automatically when their link expires.

## Steps for the agent

1. Ask your human to run this in their own terminal. It prompts for the share-me token for this host
   and checks it. Do not ask them to paste the token into this chat.

       npx -y share-me-mcp login ${baseUrl}

2. Register the MCP server in the client you are running in:

   - Claude Code: \`claude mcp add share-me --scope user -- npx -y share-me-mcp\`
   - Codex CLI: \`codex mcp add share-me -- npx -y share-me-mcp\`
   - Cursor (\`~/.cursor/mcp.json\`) or Claude Desktop (\`claude_desktop_config.json\`), then restart the app:

     \`\`\`json
     { "mcpServers": { "share-me": { "command": "npx", "args": ["-y", "share-me-mcp"] } } }
     \`\`\`

3. Reload MCP servers and call \`list_links\` to confirm the connection.

4. Save files you want to share in \`~/agent-output\` (created automatically), then call \`share_file\`
   with the absolute path. Give your human the link and tell them when it expires.

## Tools

- \`share_file(path, ttl_hours?, filename?)\`: upload a file and get an expiring link.
- \`list_links()\`: see active links and when they expire.
- \`revoke_link(id)\`: end a link early; the file is deleted.

## Good practice

- Share only files your human asked you to share.
- If a link went to the wrong person, revoke it.
`;
}
