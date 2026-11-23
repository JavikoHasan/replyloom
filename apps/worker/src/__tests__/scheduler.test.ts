import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../scheduler";

describe("Scheduler durable watchdog cursor", () => {
  it("reads and persists the cursor without using Workers KV", async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: vi.fn(async (key: string) => values.get(key)),
      put: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
      setAlarm: vi.fn(),
    };
    const scheduler = new Scheduler({ storage } as any, {} as any);

    const initial = await scheduler.fetch(new Request("https://scheduler.internal/watchdog-cursor"));
    await expect(initial.json()).resolves.toEqual({ cursor: "" });

    const saved = await scheduler.fetch(new Request("https://scheduler.internal/watchdog-cursor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cursor: "session-200" }),
    }));
    expect(saved.status).toBe(200);
    expect(storage.put).toHaveBeenCalledWith("watchdog-session-cursor", "session-200");

    const next = await scheduler.fetch(new Request("https://scheduler.internal/watchdog-cursor"));
    await expect(next.json()).resolves.toEqual({ cursor: "session-200" });
  });

  it("rejects malformed cursor updates", async () => {
    const storage = { get: vi.fn(), put: vi.fn(), setAlarm: vi.fn() };
    const scheduler = new Scheduler({ storage } as any, {} as any);
    const response = await scheduler.fetch(new Request("https://scheduler.internal/watchdog-cursor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cursor: 123 }),
    }));
    expect(response.status).toBe(400);
    expect(storage.put).not.toHaveBeenCalled();
  });
});
