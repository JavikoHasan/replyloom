import { describe, it, expect, vi } from "vitest";
import { chunkText, retrieveContext } from "../rag";

describe("chunkText", () => {
  it("returns [] for empty or whitespace-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("  \n  \t")).toEqual([]);
  });

  it("packs short paragraphs into a single chunk", () => {
    const chunks = chunkText("This is a short intro.\n\nAnd a follow up.\n\nExample.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("This is a short intro.");
    expect(chunks[0]).toContain("Example.");
  });

  it("normalizes CRLF to LF before chunking", () => {
    const chunks = chunkText("Hello\r\nworld\r\n\r\nNext section");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Hello\nworld");
    expect(chunks[0]).not.toContain("\r");
  });

  it("flushes a chunk once the size boundary is crossed", () => {
    const chunks = chunkText(`${"x".repeat(60)}\n\n${"y".repeat(60)}\n\n${"z".repeat(20)}`, 100);
    expect(chunks).toEqual(["x".repeat(60), `${"y".repeat(60)}\n${"z".repeat(20)}`]);
  });

  it("hard-slices an oversize paragraph", () => {
    const chunks = chunkText("a".repeat(2000), 500);
    expect(chunks).toHaveLength(4);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
  });
});

describe("D1 knowledge retrieval", () => {
  it("retrieves matching Spanish product facts without embeddings", async () => {
    const all = vi.fn().mockResolvedValue({
      results: [
        { id: "chunk-1", text: "Samsung A17 4/128 disponible. Garantía de 15 días.", source: "catalogo" },
        { id: "chunk-2", text: "Entrega gratuita en Sagua la Grande.", source: "entregas" },
      ],
    });
    const bind = vi.fn().mockReturnValue({ all });
    const prepare = vi.fn().mockReturnValue({ bind });
    const env = { DB: { prepare } } as any;
    const config = { workspaceId: "workspace-1", maxContextChunks: 4 } as any;

    const matches = await retrieveContext(env, config, "¿Cuánto cuesta Samsung A17 y tiene garantía?");

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("FROM doc_chunks"));
    expect(bind).toHaveBeenCalledWith(
      "workspace-1",
      "*cuesta*",
      "*s[aáÁ]ms[uúÚüÜ][nñÑ]g*",
      "*[aáÁ]17*",
      "*g[aáÁ]r[aáÁ][nñÑ]t[iíÍ][aáÁ]*",
    );
    expect(matches[0].id).toBe("chunk-1");
    expect(matches[0].score).toBeGreaterThan(0);
  });

  it("returns no context when there are no meaningful search terms", async () => {
    const prepare = vi.fn();
    const env = { DB: { prepare } } as any;
    const config = { workspaceId: "workspace-1", maxContextChunks: 4 } as any;

    await expect(retrieveContext(env, config, "¿y de la?")).resolves.toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });
});
