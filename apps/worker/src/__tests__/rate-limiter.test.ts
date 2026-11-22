import { describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../rate-limiter";

describe("SQLite Durable Object rate limiter", () => {
  it("allows requests within the fixed-window limit", async () => {
    const exec = vi.fn().mockReturnValue({ toArray: () => [{ hits: 1 }] });
    const state = { storage: { sql: { exec }, get: vi.fn().mockResolvedValue(Date.now()), put: vi.fn() } } as any;
    const limiter = new RateLimiter(state);

    const response = await limiter.fetch(new Request("https://rate-limit.internal/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyHash: "a".repeat(64), limit: 5, windowMs: 60_000 }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, remaining: 4 });
  });

  it("blocks requests after the limit is exceeded", async () => {
    const exec = vi.fn().mockReturnValue({ toArray: () => [{ hits: 6 }] });
    const state = { storage: { sql: { exec }, get: vi.fn().mockResolvedValue(Date.now()), put: vi.fn() } } as any;
    const limiter = new RateLimiter(state);

    const response = await limiter.fetch(new Request("https://rate-limit.internal/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyHash: "a".repeat(64), limit: 5, windowMs: 60_000 }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: false, remaining: 0 });
  });

  it("rejects invalid limits", async () => {
    const exec = vi.fn().mockReturnValue({ toArray: () => [] });
    const state = { storage: { sql: { exec }, get: vi.fn().mockResolvedValue(Date.now()), put: vi.fn() } } as any;
    const limiter = new RateLimiter(state);

    const response = await limiter.fetch(new Request("https://rate-limit.internal/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyHash: "a".repeat(64), limit: 0, windowMs: 60_000 }),
    }));

    expect(response.status).toBe(400);
  });
});
