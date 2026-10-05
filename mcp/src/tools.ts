import { basename, extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { openShareableFile } from "./allowlist.js";
import type { HostClient, HostPolicy, SharedLink } from "./client.js";
import type { McpConfig } from "./config.js";
import { findSecret } from "./secretScan.js";

const HOUR_SECONDS = 3600;

type ToolResult = CallToolResult & { content: [{ type: "text"; text: string }] };

const ok = (text: string, structuredContent?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structuredContent ? { structuredContent } : {}),
});

const fail = (err: unknown): ToolResult => ({
  content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

const describeLink = (l: SharedLink) => `${l.url}  (${l.filename}, ${l.size} bytes, expires ${l.expiresAt}, id ${l.id})`;

export const shareFileInput = {
  path: z.string().min(1).describe("Absolute path of the local file to share. Must be inside an allowed share directory."),
  ttl_hours: z.number().positive().optional().describe("How long the link stays valid, in hours. Defaults to the server default; the host caps it at its max TTL."),
  filename: z.string().min(1).max(255).optional().describe("Name the recipient sees. Defaults to the file's own name."),
};

export const revokeLinkInput = {
  id: z.string().min(1).describe("The link id returned by share_file or list_links."),
};

type ShareFileArgs = z.infer<z.ZodObject<typeof shareFileInput>>;
type RevokeLinkArgs = z.infer<z.ZodObject<typeof revokeLinkInput>>;

function requireAllowedType(filename: string, policy: HostPolicy): void {
  const ext = extname(filename).slice(1).toLowerCase();
  if (ext && policy.allowedExtensions.includes(ext)) return;
  const allowed = policy.allowedExtensions.map((e) => `.${e}`).join(", ");
  throw new Error(`File type ${ext ? `.${ext}` : "(no extension)"} is not allowed by the share host. Allowed: ${allowed}`);
}

export function createShareTools(config: McpConfig, client: HostClient) {
  // Fetched once so disallowed types are rejected before uploading; retried if the fetch fails.
  let policy: Promise<HostPolicy> | undefined;
  const getPolicy = (): Promise<HostPolicy> =>
    (policy ??= client.getConfig().catch((err: unknown) => {
      policy = undefined;
      throw err;
    }));

  async function shareFile(args: ShareFileArgs): Promise<ToolResult> {
    let file: Awaited<ReturnType<typeof openShareableFile>> | undefined;
    try {
      file = await openShareableFile(args.path, config.allowedDirs);
      if (file.size > config.maxFileBytes) {
        throw new Error(`File is ${file.size} bytes, over the ${config.maxFileBytes}-byte share limit`);
      }
      const filename = args.filename ?? basename(file.path);
      requireAllowedType(filename, await getPolicy());
      const secret = await findSecret(file.handle, file.size);
      if (secret) throw new Error(`Refusing to share "${args.path}": it appears to contain a ${secret}`);
      const link = await client.upload({
        // Stream from the verified handle, not the path, so the file can't be swapped after the checks.
        body: file.handle.createReadStream({ start: 0, autoClose: false }),
        size: file.size,
        filename,
        ttlSeconds: Math.max(1, Math.round((args.ttl_hours ?? config.defaultTtlHours) * HOUR_SECONDS)),
      });
      return ok(`Shareable link (auto-deletes at ${link.expiresAt}):\n${link.url}\n\nLink id: ${link.id}`, { ...link });
    } catch (err) {
      return fail(err);
    } finally {
      await file?.handle.close();
    }
  }

  async function listLinks(): Promise<ToolResult> {
    try {
      const links = await client.list();
      const text = links.length === 0 ? "No active shared links." : links.map(describeLink).join("\n");
      return ok(text, { links });
    } catch (err) {
      return fail(err);
    }
  }

  async function revokeLink(args: RevokeLinkArgs): Promise<ToolResult> {
    try {
      await client.revoke(args.id);
      return ok(`Revoked link ${args.id}; the file has been deleted from the host.`);
    } catch (err) {
      return fail(err);
    }
  }

  return { shareFile, listLinks, revokeLink };
}

export function registerShareTools(server: McpServer, tools: ReturnType<typeof createShareTools>): void {
  server.registerTool(
    "share_file",
    {
      title: "Share a local file as a link",
      description:
        "Upload a locally generated file to the share host and return an expiring, unguessable URL the human can send to anyone. The file is auto-deleted when the link expires. Only file types allowed by the host can be shared (typically documents, images, audio/video and plain text; not executables or scripts).",
      inputSchema: shareFileInput,
    },
    tools.shareFile,
  );
  server.registerTool(
    "list_links",
    { title: "List shared links", description: "List all currently active shared links with their expiry times." },
    tools.listLinks,
  );
  server.registerTool(
    "revoke_link",
    {
      title: "Revoke a shared link",
      description: "Immediately invalidate a shared link and delete the file from the host.",
      inputSchema: revokeLinkInput,
      annotations: { destructiveHint: true },
    },
    tools.revokeLink,
  );
}
