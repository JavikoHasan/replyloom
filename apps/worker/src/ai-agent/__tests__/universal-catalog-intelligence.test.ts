import { describe, expect, it } from "vitest";
import {
  buildShortCatalogProductSelectionReply,
  isShortCatalogProductSelection,
  buildUniversalCatalogTechnicalReply,
  isUniversalCatalogTechnicalQuestion,
} from "../universal-catalog-intelligence";

const sync = { stage: "completed", updatedAt: "2026-11-25T14:00:00.000Z" };
const now = Date.parse("2026-11-25T14:10:00.000Z");

describe("universal catalog intelligence", () => {
  it("recognizes short natural selections without hard-coding product models", () => {
    expect(isShortCatalogProductSelection("La nevera")).toBe(true);
    expect(isShortCatalogProductSelection("Me interesa una nevera")).toBe(true);
    expect(isShortCatalogProductSelection("Una bicicleta eléctrica")).toBe(true);
    expect(isShortCatalogProductSelection("Un momento")).toBe(false);
  });

  it("resolves a generic new product selection against its own catalog title", () => {
    const context = [{ text: "PRODUCTO: NEVERA MIDEA 7 PIES\nCategoría: Hogar\nPrecio publicado: 450 USD\nDisponibilidad publicada: Disponible" }];
    const reply = buildShortCatalogProductSelectionReply("Me interesa una nevera", context, sync, now);
    expect(reply).toContain("NEVERA MIDEA 7 PIES");
    expect(reply).toContain("450 USD");
  });

  it("asks the customer to distinguish multiple products matching a broad brand selection", () => {
    const context = [
      { text: "PRODUCTO: ECOFLOW DELTA 2\nPrecio publicado: 800 USD" },
      { text: "PRODUCTO: ECOFLOW RIVER 2 PRO\nPrecio publicado: 630 USD" },
    ];
    const reply = buildShortCatalogProductSelectionReply("La EcoFlow", context, sync, now);
    expect(reply).toContain("Encontré varios anuncios");
    expect(reply).toContain("¿Cuál de ellos te interesa?");
  });

  it("recognizes technical questions without restricting them to phones", () => {
    for (const q of [
      "¿Qué propiedades tiene?",
      "Características del teléfono",
      "¿Qué potencia tiene la estación?",
      "¿Qué cilindrada tiene la moto?",
      "¿Cuánta capacidad tiene?",
      "¿Qué dimensiones tiene el equipo?",
    ]) expect(isUniversalCatalogTechnicalQuestion(q), q).toBe(true);
  });

  it("answers a phone using only specs present in its product title", () => {
    const context = [{ text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM\nCategoría: Telefonía\nPrecio publicado: 190 USD" }];
    const reply = buildUniversalCatalogTechnicalReply("¿Qué propiedades tiene?", "Un A16", context, sync, now);
    expect(reply).toContain("RAM: 4 GB");
    expect(reply).toContain("Almacenamiento: 128 GB");
    expect(reply).not.toMatch(/procesador|cámara|batería/i);
  });

  it("recovers a product named earlier in the conversation when the current question is elliptical", () => {
    const context = [{ text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM" }];
    const thread = "[Previous messages]\nCustomer: Me interesa un teléfono\nAgent: Tenemos varias opciones\nCustomer: Un A16\nAgent: El A16 aparece en catálogo";
    const reply = buildUniversalCatalogTechnicalReply("¿Qué propiedades tiene?", "¿Qué propiedades tiene?", context, sync, now, thread);
    expect(reply).toContain("SAMSUNG GALAXY A16");
    expect(reply).toContain("RAM: 4 GB");
  });

  it("does not revive an older product after the customer starts a new catalog search", () => {
    const context = [{ text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM" }];
    const thread = "[Previous messages]\nCustomer: Un A16\nAgent: El A16 aparece en catálogo\\nCustomer: ¿Qué tienes en venta?\\nAgent: Tenemos varios productos";
    const reply = buildUniversalCatalogTechnicalReply("¿Qué propiedades tiene?", "¿Qué tienes en venta?", context, sync, now, thread);
    expect(reply).toBeNull();
  });

  it("answers an energy station from its published capacity and power fields", () => {
    const context = [{ text: "PRODUCTO: ECOFLOW DELTA 2 — 1024Wh\nCategoría: Estaciones de energía\nPotencia: 1800W\nQuímica de batería: LiFePO4" }];
    const reply = buildUniversalCatalogTechnicalReply("¿Qué potencia y capacidad tiene?", "EcoFlow Delta 2", context, sync, now);
    expect(reply).toContain("1024 Wh");
    expect(reply).toContain("1800W");
    expect(reply).toContain("LiFePO4");
  });

  it("answers a motorcycle from its published displacement without inventing other specs", () => {
    const context = [{ text: "PRODUCTO: XMX 250cc\nCategoría: Motocicletas\nPrecio publicado: 3000 USD" }];
    const reply = buildUniversalCatalogTechnicalReply("¿Qué cilindrada tiene?", "XMX 250cc", context, sync, now);
    expect(reply).toContain("250 cc");
    expect(reply).not.toMatch(/caballos|velocidad máxima|frenos/i);
  });

  it("can answer a new product category from its own public description", () => {
    const context = [{ text: "PRODUCTO: AIRE ACONDICIONADO DE BAJO CONSUMO\nCategoría: Hogar\nDescripción y características publicadas: Equipo de 110V con consumo de 380Wh. Ideal para respaldo energético." }];
    const reply = buildUniversalCatalogTechnicalReply("¿Qué consumo tiene?", "Aire acondicionado de bajo consumo", context, sync, now);
    expect(reply).toContain("110V");
    expect(reply).toContain("380Wh");
  });

  it("does not infer facts when the listing contains no technical information", () => {
    const context = [{ text: "PRODUCTO: PRODUCTO NUEVO\nCategoría: Otros\nPrecio publicado: 50 USD" }];
    const reply = buildUniversalCatalogTechnicalReply("¿Qué características tiene?", "Producto nuevo", context, sync, now);
    expect(reply).toContain("no contiene características técnicas suficientes");
  });

  it("does not answer from stale catalog synchronization", () => {
    const context = [{ text: "PRODUCTO: ECOFLOW DELTA 2 — 1024Wh\nPotencia: 1800W" }];
    const stale = { stage: "completed", updatedAt: "2026-11-25T01:00:00.000Z" };
    expect(buildUniversalCatalogTechnicalReply("¿Qué potencia tiene?", "EcoFlow Delta 2", context, stale, now)).toBeNull();
  });

  it("does not confuse a short model code with a longer one", () => {
    const context = [{ text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM" }];
    const reply = buildUniversalCatalogTechnicalReply("¿Qué características tiene?", "A1", context, sync, now);
    expect(reply).toBeNull();
  });
});
