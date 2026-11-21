import { describe, expect, it, vi } from "vitest";
import { isWorthIndexing, semanticSearch } from "../search";

describe("D1 message search", () => {
  it("keeps the existing short-message filter behavior", () => {
    expect(isWorthIndexing("ok")).toBe(false);
    expect(isWorthIndexing("Can you confirm delivery?")).toBe(true);
  });

  it("searches only within the requested workspace and ranks matching text", async () => {
    const all = vi.fn().mockResolvedValue({
      results: [
        {
          messageId: "message-1",
          conversationId: "conversation-1",
          waSessionId: "session-1",
          text: "Samsung A17 4/128 disponible con garantía.",
          isGroup: 0,
        },
        {
          messageId: "message-2",
          conversationId: "conversation-2",
          waSessionId: "session-1",
          text: "El A17 tiene 128GB.",
          isGroup: 0,
        },
      ],
    });
    const bind = vi.fn().mockReturnValue({ all });
    const prepare = vi.fn().mockReturnValue({ bind });
    const env = { DB: { prepare } } as any;

    const matches = await semanticSearch(env, "workspace-1", "Samsung A17 garantía", 10);

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("m.workspace_id = ?"));
    expect(bind).toHaveBeenCalledWith(
      "workspace-1",
      "samsung",
      "a17",
      "garantia",
      80,
    );
    expect(matches[0].messageId).toBe("message-1");
    expect(matches[0].score).toBeGreaterThan(matches[1].score);
  });

  it("returns no matches for a query containing only stop words", async () => {
    const prepare = vi.fn();
    const env = { DB: { prepare } } as any;
    await expect(semanticSearch(env, "workspace-1", "¿y de la?")).resolves.toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });
});
