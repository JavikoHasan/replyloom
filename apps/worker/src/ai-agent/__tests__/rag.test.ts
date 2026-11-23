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
      "cuesta",
      "samsung",
      "a17",
      "garantia",
    );
    expect(matches[0].id).toBe("chunk-1");
    expect(matches[0].score).toBeGreaterThan(0);
  });

  it("restricts the store catalog to the approved Revolico source", async () => {
    const all = vi.fn().mockResolvedValue({ results: [
      { id: "catalog-1", text: "Samsung A17 4/128 precio 200 USD", source: "revolico-sagua.pages.dev (anuncios públicos)" },
    ] });
    const bind = vi.fn().mockReturnValue({ all });
    const prepare = vi.fn().mockReturnValue({ bind });
    const env = { DB: { prepare } } as any;
    const config = { workspaceId: "workspace-1", maxContextChunks: 4 } as any;

    await retrieveContext(env, config, "Samsung A17", "revolico-sagua.pages.dev");

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("source LIKE ?"));
    expect(bind).toHaveBeenCalledWith("workspace-1", "revolico-sagua.pages.dev%", "samsung", "a17");
  });



  it("includes a pinned phone policy even when its wording does not match the product query", async () => {
    const all = vi.fn().mockResolvedValue({
      results: [
        {
          id: "catalog-f07",
          text: "PRODUCTO: SAMSUNG GALAXY F07 — 4GB RAM / 64GB ROM\\nPrecio publicado: 150 USD",
          source: "revolico-sagua.pages.dev (catalog)",
          doc_id: "revolico-sagua-public-catalog",
        },
        {
          id: "phone-policy",
          text: "Todos los teléfonos celulares incluyen cover de fábrica, cable, cargador, mica protectora de cristal templado y 15 días de garantía.",
          source: "Condiciones de venta y garantía de teléfonos",
          doc_id: "condiciones-venta-telefonos",
        },
      ],
    });
    const bind = vi.fn().mockReturnValue({ all });
    const prepare = vi.fn().mockReturnValue({ bind });
    const env = { DB: { prepare } } as any;
    const config = { workspaceId: "workspace-1", maxContextChunks: 4 } as any;

    const matches = await retrieveContext(
      env,
      config,
      "Qué incluye la compra del Samsung F07?",
      "revolico-sagua.pages.dev",
      ["condiciones-venta-telefonos"],
    );

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("doc_id IN (?)"));
    expect(bind).toHaveBeenCalledWith(
      "workspace-1",
      "revolico-sagua.pages.dev%",
      "incluye",
      "compra",
      "samsung",
      "f07",
      "condiciones-venta-telefonos",
    );
    expect(matches.map((chunk: { id: string }) => chunk.id)).toContain("phone-policy");
    expect(matches.map((chunk: { id: string }) => chunk.id)).toContain("catalog-f07");
  });

  it("prioritizes the exact requested store model over other catalog products", async () => {
    const all = vi.fn().mockResolvedValue({ results: [
      { id: "other-phone", text: "PRODUCTO: SAMSUNG GALAXY A17 — 4GB RAM / 128GB ROM\\nPrecio publicado: 190 USD", source: "revolico-sagua.pages.dev (catalog)" },
      { id: "requested-phone", text: "PRODUCTO: SAMSUNG GALAXY F07 — 4GB RAM / 64GB ROM\\nPrecio publicado: 150 USD", source: "revolico-sagua.pages.dev (catalog)" },
      { id: "phone-policy", text: "Todos los teléfonos incluyen accesorios y 15 días de garantía.", source: "Condiciones", doc_id: "condiciones-venta-telefonos" },
    ] });
    const bind = vi.fn().mockReturnValue({ all });
    const prepare = vi.fn().mockReturnValue({ bind });
    const env = { DB: { prepare } } as any;
    const config = { workspaceId: "workspace-1", maxContextChunks: 4 } as any;

    const matches = await retrieveContext(
      env,
      config,
      "¿Cuánto cuesta el Samsung F07 de 4GB RAM y 64GB de almacenamiento?",
      "revolico-sagua.pages.dev",
      ["condiciones-venta-telefonos"],
    );

    expect(matches.map((chunk) => chunk.id)).toContain("requested-phone");
    expect(matches.map((chunk) => chunk.id)).toContain("phone-policy");
    expect(matches.map((chunk) => chunk.id)).not.toContain("other-phone");
  });

  it("does not substitute another listing when the requested store model is absent", async () => {
    const all = vi.fn().mockResolvedValue({ results: [
      { id: "other-phone", text: "PRODUCTO: SAMSUNG GALAXY F07 — 4GB RAM / 64GB ROM", source: "revolico-sagua.pages.dev (catalog)" },
      { id: "phone-policy", text: "Todos los teléfonos incluyen accesorios.", source: "Condiciones", doc_id: "condiciones-venta-telefonos" },
    ] });
    const bind = vi.fn().mockReturnValue({ all });
    const prepare = vi.fn().mockReturnValue({ bind });
    const env = { DB: { prepare } } as any;
    const config = { workspaceId: "workspace-1", maxContextChunks: 4 } as any;

    const matches = await retrieveContext(
      env,
      config,
      "¿Tienen disponible el Samsung A07?",
      "revolico-sagua.pages.dev",
      ["condiciones-venta-telefonos"],
    );

    expect(matches).toEqual([]);
  });

  it("returns no context when there are no meaningful search terms", async () => {
    const prepare = vi.fn();
    const env = { DB: { prepare } } as any;
    const config = { workspaceId: "workspace-1", maxContextChunks: 4 } as any;

    await expect(retrieveContext(env, config, "¿y de la?")).resolves.toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });
});
