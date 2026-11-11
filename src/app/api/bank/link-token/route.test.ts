import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/auth/rbac";

const requireUser = vi.hoisted(() => vi.fn());
const createLinkToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/session", () => ({ requireUser }));
vi.mock("@/lib/bank/items", () => ({ createLinkToken }));

import { POST } from "./route";

const ORIGIN = "http://localhost:3000";
const req = (init: { origin?: string | null; body?: string } = {}) =>
  new Request(`${ORIGIN}/api/bank/link-token`, {
    method: "POST",
    headers: { ...(init.origin === null ? {} : { origin: init.origin ?? ORIGIN }), "content-type": "application/json" },
    body: init.body,
  });

beforeEach(() => {
  process.env.DATABASE_URL ??= "postgres://x@localhost/x"; process.env.BETTER_AUTH_SECRET ??= "x".repeat(32); process.env.APP_URL = ORIGIN;
  requireUser.mockReset().mockResolvedValue({ id: "u1", role: "user" });
  createLinkToken.mockReset().mockResolvedValue({ linkToken: "link-sandbox-1" });
});

describe("POST /api/bank/link-token", () => {
  it("requires a signed-in user", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());
    expect((await POST(req())).status).toBe(401);
    expect(createLinkToken).not.toHaveBeenCalled();
  });
  it("refuses cross-origin and origin-less requests", async () => {
    expect((await POST(req({ origin: "https://sibling.breakthruventures.ai" }))).status).toBe(403);
    expect((await POST(req({ origin: null }))).status).toBe(403);
    expect(createLinkToken).not.toHaveBeenCalled();
  });
  it("returns the link token for the acting user, with an empty or {} body", async () => {
    for (const body of [undefined, "{}"]) {
      const res = await POST(req({ body }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ linkToken: "link-sandbox-1" });
    }
    expect(createLinkToken).toHaveBeenCalledWith({ id: "u1", role: "user" });
  });
  it("rejects unexpected input and oversized or non-JSON bodies", async () => {
    expect((await POST(req({ body: '{"userId":"someone-else"}' }))).status).toBe(400);
    expect((await POST(req({ body: "not json" }))).status).toBe(400);
    expect((await POST(req({ body: JSON.stringify({ pad: "x".repeat(2000) }) }))).status).toBe(413);
    expect(createLinkToken).not.toHaveBeenCalled();
  });
});
