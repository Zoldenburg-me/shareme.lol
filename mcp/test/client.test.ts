import { describe, expect, it, vi } from "vitest";
import { HostClient, signup } from "../src/client.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("signup", () => {
  it("requests a new token from the host", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(201, { token: "sm_abc", id: "tok_1", quotaBytes: 10 }));
    const result = await signup("https://shareme.lol", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("https://shareme.lol/api/tokens", expect.objectContaining({ method: "POST" }));
    expect(result).toMatchObject({ token: "sm_abc", id: "tok_1" });
  });

  it("explains a refused signup with the host's own message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(429, { error: "Too many signups from your network; try again in an hour" }));
    await expect(signup("https://shareme.lol", fetchImpl as unknown as typeof fetch)).rejects.toThrow(/429: Too many signups/);
  });

  it("reports an unreachable host", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(signup("https://shareme.lol", fetchImpl as unknown as typeof fetch)).rejects.toThrow(/Could not reach/);
  });
});

describe("HostClient.extend", () => {
  const link = { id: "AAAAAAAAAAAAAAAAAAAAAA", url: "https://h/f/A/a.md", filename: "a.md", size: 5, expiresAt: "2026-11-08T12:00:00.000Z" };
  const required = { x402Version: 2, accepts: [{ scheme: "exact", amount: "10001" }] };
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

  it("posts the new TTL and returns the extended link with the settlement receipt", async () => {
    const res = json(200, link);
    res.headers.set("payment-response", b64({ success: true, transaction: "0xtx" }));
    const fetchImpl = vi.fn().mockResolvedValue(res);
    const client = new HostClient("https://h", "sm_t", fetchImpl as unknown as typeof fetch);

    expect(await client.extend(link.id, 3600, "PAYLOAD==")).toEqual({ kind: "extended", link, receipt: { success: true, transaction: "0xtx" } });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://h/api/files/${link.id}/extend`);
    expect(init.headers).toMatchObject({ authorization: "Bearer sm_t", "content-type": "application/json", "payment-signature": "PAYLOAD==" });
    expect(JSON.parse(String(init.body))).toEqual({ ttlSeconds: 3600 });
  });

  it("returns the host's payment quote on a 402", async () => {
    const res = json(402, { error: "Payment required", price: "0.010001", currency: "USDC", paymentRequired: required });
    res.headers.set("payment-required", b64(required));
    const client = new HostClient("https://h", "t", vi.fn().mockResolvedValue(res) as unknown as typeof fetch);
    expect(await client.extend(link.id, 3600)).toEqual({
      kind: "payment_required", message: "Payment required", price: "0.010001", currency: "USDC", paymentRequired: required, header: b64(required),
    });
  });

  it("treats a 402 without a payment header as an error", async () => {
    const client = new HostClient("https://h", "t", vi.fn().mockResolvedValue(json(402, { error: "nope" })) as unknown as typeof fetch);
    await expect(client.extend(link.id, 3600)).rejects.toThrow(/402: nope/);
  });
});
