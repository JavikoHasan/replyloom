import { describe, expect, it } from "vitest";
import {
  buildCatalogLookupReply,
  isCatalogLookupQuestion,
  resolveRecentProductQuery,
} from "../agent";
import { generateCatalogQueryVariants, normalizeStoreCatalogQuery } from "../catalog-query-normalization";

const sync = { stage: "completed", updatedAt: "2026-11-24T19:55:00.000Z" };
const now = Date.parse("2026-11-24T20:00:00.000Z");
const catalog = [
  {
    id: "f07",
    source: "revolico-sagua.pages.dev (catalog)",
    score: 1,
    text: [
      "PRODUCTO: SAMSUNG GALAXY F07 — 4GB RAM / 64GB ROM",
      "Categoría: Telefonía",
      "Precio publicado: 150 USD",
      "Disponibilidad publicada: Disponible",
    ].join("\n"),
  },
  {
    id: "delta2",
    source: "revolico-sagua.pages.dev (catalog)",
    score: 1,
    text: [
      "PRODUCTO: ECOFLOW DELTA 2 — 1024Wh",
      "Categoría: Estaciones de energía",
      "Precio publicado: 800 USD",
      "Disponibilidad publicada: Disponible",
    ].join("\n"),
  },
];

describe("Cell Phone Store query stress laboratory", () => {
  it("generates case, accent, spacing and typo variants without changing the source query", () => {
    const original = "¿Tienes estaciones de energía?";
    const variants = generateCatalogQueryVariants(original);
    expect(variants).toContain(original);
    expect(variants).toContain(original.toUpperCase());
    expect(variants.some((value) => value.includes("estacones"))).toBe(true);
    expect(variants.some((value) => value.includes("enerjia"))).toBe(true);
  });

  it("routes broad questions phrased as what do you have for sale to the full catalog", () => {\n    for (const question of ["¿Qué tienes en venta?", "Que tienes en venta", "Que tienes?", "Que hay en venta", "¿Qué cosas tienes?"]) {\n      expect(isCatalogLookupQuestion(question), question).toBe(true);\n      const reply = buildCatalogLookupReply(question, catalog, sync, now);\n      expect(reply, question).toContain("SAMSUNG GALAXY F07");\n      expect(reply, question).toContain("ECOFLOW DELTA 2");\n    }\n  });\n\n  it("routes generated F07 spelling and capitalization variants to the same exact catalog result", () => {
    const variants = generateCatalogQueryVariants("¿Tienes Samsung F07?");
    for (const question of variants) {
      expect(isCatalogLookupQuestion(question), question).toBe(true);
      const reply = buildCatalogLookupReply(question, catalog, sync, now);
      expect(reply, question).toContain("SAMSUNG GALAXY F07");
      expect(reply, question).toContain("150 USD");
      expect(reply, question).not.toContain("ECOFLOW");
    }
  });

  it("corrects common missing-letter errors in Spanish intent words", () => {
    for (const question of [
      "¿Tines Samsung F07?",
      "¿Tienes estacion de enerjia?",
      "¿Tienes cargdor?",
    ]) {
      expect(isCatalogLookupQuestion(question), question).toBe(true);
    }
    expect(normalizeStoreCatalogQuery("¿Tines Samsung F07?")).toContain("tienes");
    expect(normalizeStoreCatalogQuery("¿Tienes Oups?")).toContain("oupes");
    expect(normalizeStoreCatalogQuery("¿Tienes cargdor?")).toContain("cargador");
  });

  it("keeps brand requests isolated and never substitutes EcoFlow for Oupes", () => {
    const question = "¿Tienes estaciones de energía marca Oups?";
    expect(isCatalogLookupQuestion(question)).toBe(true);
    const reply = buildCatalogLookupReply(question, catalog, sync, now);
    expect(reply).toContain("marca OUPES");
    expect(reply).toContain("no encuentro anuncios vigentes");
    expect(reply).not.toContain("ECOFLOW");
  });

  it("keeps the cable and charger policy correct under case and typo variations", () => {
    for (const question of generateCatalogQueryVariants("¿Tienes cargador en venta?")) {
      expect(isCatalogLookupQuestion(question), question).toBe(true);
      const reply = buildCatalogLookupReply(question, catalog, sync, now);
      expect(reply, question).toContain("No vendemos cables ni cargadores por separado");
      expect(reply, question).toContain("Se incluyen con la compra de cualquiera de nuestros teléfonos");
      expect(reply, question).not.toContain("ECOFLOW");
    }
  });

  it("does not fuzzy-match a short model code to a longer model", () => {
    const a16 = [{
      id: "a16",
      source: "catalog",
      score: 1,
      text: [
        "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM",
        "Categoría: Telefonía",
        "Precio publicado: 190 USD",
        "Disponibilidad publicada: Disponible",
      ].join("\n"),
    }];
    const reply = buildCatalogLookupReply("¿Tienes A1?", a16, sync, now);
    expect(reply?.toLowerCase()).toContain("no encuentro un anuncio vigente");
    expect(reply).not.toContain("SAMSUNG GALAXY A16");
  });

  it("treats a fresh category query as a context boundary after a previous product", () => {
    const thread = "[Previous messages]\nCustomer: ¿Tienes F07?\nAgent: Sí, aparece en catálogo.";
    expect(resolveRecentProductQuery("¿Tienes EcoFlow?", thread)).toBe("¿Tienes EcoFlow?");
  });

  it("does not make claims when the catalog synchronization is stale", () => {
    expect(buildCatalogLookupReply(
      "¿Tines Samsung F07?",
      catalog,
      { stage: "completed", updatedAt: "2026-11-24T10:00:00.000Z" },
      now,
    )).toBeNull();
  });
});
