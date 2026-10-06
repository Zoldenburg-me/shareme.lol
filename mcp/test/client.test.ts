import { describe, expect, it, vi } from "vitest";
import { signup } from "../src/client.js";

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
