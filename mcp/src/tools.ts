import { basename, extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { openShareableFile } from "./allowlist.js";
import type { ExtendResult, HostClient, HostPolicy, SharedLink } from "./client.js";
import type { McpConfig } from "./config.js";
import { findSecret } from "./secretScan.js";

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86_400;
// An x402 v2 payment payload, base64: a few hundred bytes.
const MAX_PAYMENT_LENGTH = 16_384;
// About a year: the most any host is expected to sell.
const MAX_EXTEND_HOURS = 24 * 366;
// $1 in USDC (6 decimals). Set SHARE_MAX_PAYMENT_ATOMIC to allow more per payment.
const DEFAULT_MAX_PAYMENT_ATOMIC = 1_000_000;
const MAX_HOST_MESSAGE_LENGTH = 200;

type ToolResult = CallToolResult & { content: [{ type: "text"; text: string }] };

const ok = (text: string, structuredContent?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structuredContent ? { structuredContent } : {}),
});

const fail = (err: unknown): ToolResult => ({
  content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

const describeLink = (l: SharedLink) => `${l.shortUrl ?? l.url}  (${l.filename}, ${l.size} bytes, expires ${l.expiresAt}, id ${l.id})`;

export const shareFileInput = {
  path: z.string().min(1).describe("Absolute path of the local file to share. Must be inside an allowed share directory."),
  ttl_hours: z.number().positive().optional().describe("How long the link stays valid, in hours. Defaults to the server default; the host caps it at its max TTL."),
  filename: z.string().min(1).max(255).optional().describe("Name the recipient sees. Defaults to the file's own name."),
};

export const revokeLinkInput = {
  id: z.string().min(1).describe("The link id returned by share_file or list_links."),
};

export const extendLinkInput = {
  id: z.string().min(1).describe("The link id returned by share_file or list_links."),
  ttl_hours: z.number().positive().max(MAX_EXTEND_HOURS).describe("How long from now the link should stay valid, in hours."),
  payment: z.string().max(MAX_PAYMENT_LENGTH).regex(/^[A-Za-z0-9+/=]+$/).optional().describe(
    "Only when retrying after a payment quote: the base64 x402 PAYMENT-SIGNATURE your wallet produced for that quote.",
  ),
};

type ShareFileArgs = z.infer<z.ZodObject<typeof shareFileInput>>;
type ExtendLinkArgs = z.infer<z.ZodObject<typeof extendLinkInput>>;
type RevokeLinkArgs = z.infer<z.ZodObject<typeof revokeLinkInput>>;

function days(seconds: number): string {
  const n = Math.round((seconds / DAY_SECONDS) * 10) / 10;
  return `${n} ${n === 1 ? "day" : "days"}`;
}

function cappedNote(link: SharedLink): string {
  if (!link.ttlCapped || !link.requestedTtlSeconds || !link.maxTtlSeconds) return "";
  return `\n\nNote: the host capped this link at ${days(link.maxTtlSeconds)} (you asked for ${days(link.requestedTtlSeconds)}). ` +
    "To keep it longer, call extend_link; past your plan's limit the host quotes a small x402 payment.";
}

// Host and facilitator text reaches the agent's context; keep it short and on one line.
const hostText = (value: string | undefined) =>
  (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_HOST_MESSAGE_LENGTH);

interface Terms {
  readonly amount: number;
  readonly payTo: string;
}

/** Amount and recipient of the first quoted (or signed) requirement. */
function termsOf(requirement: unknown): Terms | undefined {
  if (typeof requirement !== "object" || requirement === null) return undefined;
  const { amount, payTo } = requirement as { amount?: unknown; payTo?: unknown };
  const value = typeof amount === "string" && /^\d+$/.test(amount) ? Number(amount) : NaN;
  return Number.isSafeInteger(value) && typeof payTo === "string" ? { amount: value, payTo } : undefined;
}

const quotedTerms = (paymentRequired: unknown) =>
  termsOf((paymentRequired as { accepts?: unknown[] } | null)?.accepts?.[0]);

function signedTerms(payment: string): Terms | undefined {
  try {
    return termsOf((JSON.parse(Buffer.from(payment, "base64").toString("utf8")) as { accepted?: unknown }).accepted);
  } catch {
    return undefined;
  }
}

/** Refuse terms over this server's spending cap, or paying anyone but the address the host advertises. */
function checkTerms(terms: Terms | undefined, maxAtomic: number, policy: HostPolicy): void {
  if (!terms) throw new Error("The payment quote is malformed; not paying it");
  if (terms.amount > maxAtomic) {
    throw new Error(`The quoted payment (${terms.amount} atomic units) is over this server's limit of ${maxAtomic}; ask your human to raise SHARE_MAX_PAYMENT_ATOMIC if they want this`);
  }
  const advertised = policy.payments?.x402?.payTo;
  if (advertised && advertised.toLowerCase() !== terms.payTo.toLowerCase()) {
    throw new Error("The payment quote pays a different address than the host advertises; not paying it");
  }
}

function describeExtension(result: ExtendResult): ToolResult {
  if (result.kind === "payment_required") {
    const price = result.price ? ` costs ${hostText(result.price)} ${hostText(result.currency)}`.trimEnd() : " needs a payment";
    return ok(
      `Keeping this link that long${price} (${hostText(result.message)}). ` +
        "To pay, have your x402 wallet sign the paymentRequired quote below, then call extend_link again with the same id and ttl_hours " +
        "and `payment` set to the base64 PAYMENT-SIGNATURE it returns. Only pay if your human wants the link kept this long.",
      { price: result.price, currency: result.currency, paymentRequired: result.paymentRequired, paymentRequiredHeader: result.header },
    );
  }
  const { link, receipt } = result;
  const paid = receipt?.transaction
    ? `\nPaid: transaction ${receipt.transaction} on ${receipt.network ?? "chain"}.`
    : link.paymentStatus === "pending"
      ? "\nThe host couldn't confirm the payment settled; the extension stands and the host operator will reconcile it. Don't pay again for this link."
      : "";
  return ok(`Link ${link.id} now expires at ${link.expiresAt}.${paid}`, { ...link, ...(receipt ? { receipt } : {}) });
}

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
      const links = link.shortUrl ? `${link.shortUrl}\n\nFull link: ${link.url}` : link.url;
      return ok(`Shareable link (auto-deletes at ${link.expiresAt}):\n${links}\n\nLink id: ${link.id}${cappedNote(link)}`, { ...link });
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

  async function extendLink(args: ExtendLinkArgs): Promise<ToolResult> {
    try {
      const maxAtomic = config.maxPaymentAtomic ?? DEFAULT_MAX_PAYMENT_ATOMIC;
      const ttlSeconds = Math.max(1, Math.round(args.ttl_hours * HOUR_SECONDS));
      // Checked before sending, so a signed payment over the cap never leaves this machine.
      if (args.payment) checkTerms(signedTerms(args.payment), maxAtomic, await getPolicy());
      const result = await client.extend(args.id, ttlSeconds, args.payment);
      if (result.kind === "payment_required") checkTerms(quotedTerms(result.paymentRequired), maxAtomic, await getPolicy());
      return describeExtension(result);
    } catch (err) {
      return fail(err);
    }
  }

  return { shareFile, listLinks, revokeLink, extendLink };
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
    "extend_link",
    {
      title: "Keep a shared link longer",
      description:
        "Keep an existing link valid until ttl_hours from now. Free up to your plan's limit; past it the host returns an x402 payment quote " +
        "instead. If you have an x402 wallet, sign that quote and call this tool again with `payment`. Links are never shortened.",
      inputSchema: extendLinkInput,
    },
    tools.extendLink,
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
