/** Setup guide served at /setup, written so an agent can follow it and a human can read it. */

/** Pinned so a new npm release never runs unreviewed on a machine whose files it reads. */
const PACKAGE = "share-me-mcp@0.1.0";
const HOSTED = "shareme.lol";
const SELF_HOST_GUIDE = "https://github.com/Zoldenburg-me/shareme.lol#setup";

function registerStep(): string {
  return `Register the MCP server in the client you are running in:

   - Claude Code: \`claude mcp add share-me --scope user -- npx -y ${PACKAGE}\`
   - Codex CLI: \`codex mcp add share-me -- npx -y ${PACKAGE}\`
   - Cursor (\`~/.cursor/mcp.json\`) or Claude Desktop (\`claude_desktop_config.json\`), then restart the app:

     \`\`\`json
     { "mcpServers": { "share-me": { "command": "npx", "args": ["-y", "${PACKAGE}"] } } }
     \`\`\``;
}

function hostedSteps(baseUrl: string): string {
  return `1. ${registerStep()}

   On its first start the server signs up at ${baseUrl} and saves its own access token for this
   machine to \`~/.config/share-me/config.json\`. Nothing else to configure.

2. Reload MCP servers and call \`list_links\` to confirm the connection.

3. Save files you want to share in \`~/agent-output\` (created automatically), then call \`share_file\`
   with the absolute path. Give your human the link and tell them when it expires.

Optional, in a terminal: \`npx -y ${PACKAGE} signup ${baseUrl}\` gets a fresh token up front.
Never paste a token into this chat.

Uploads to ${baseUrl} must follow the terms at ${baseUrl}/terms. Want the files on your own server
instead? Deploy the host yourself: ${SELF_HOST_GUIDE}`;
}

function selfHostedSteps(baseUrl: string): string {
  return `1. Get a token for this host, in a terminal: \`npx -y ${PACKAGE} signup ${baseUrl}\`
   If the operator gave you a token instead, the human runs \`npx -y ${PACKAGE} login ${baseUrl}\`
   in their own terminal and pastes it there. Never paste a token into this chat.

2. ${registerStep()}

   The server uses the host and token saved in step 1 (\`~/.config/share-me/config.json\`).

3. Reload MCP servers and call \`list_links\` to confirm the connection.

4. Save files you want to share in \`~/agent-output\` (created automatically), then call \`share_file\`
   with the absolute path. Give your human the link and tell them when it expires.`;
}

export function renderSetupGuide(baseUrl: string): string {
  const steps = new URL(baseUrl).host === HOSTED ? hostedSteps(baseUrl) : selfHostedSteps(baseUrl);
  return `# share-me setup

share-me is an MCP server that turns files you generate into expiring links your human can pass on.
Files are hosted at ${baseUrl} and deleted from it when their link expires or is revoked.
Anyone who opens the link can keep a copy, so share only what the recipient may keep.

## Steps for the agent

${steps}

## Tools

- \`share_file(path, ttl_hours?, filename?)\`: upload a file and get an expiring link.
- \`list_links()\`: see your active links and when they expire.
- \`extend_link(id, ttl_hours, payment?)\`: keep a link longer. Free up to your plan's limit; past it you get an x402
  payment quote. If you have an x402 wallet and your human wants the link kept, sign the quote and call again with \`payment\`.
- \`revoke_link(id)\`: end a link early; the file is deleted.

Each token has a storage quota; links you revoke or that expire free it up again.

## Good practice

- Share only files your human asked you to share.
- If a link went to the wrong person, revoke it.
`;
}
