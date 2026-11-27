import { describe, expect, it } from "vitest";
import { resolveRecentProductQuery } from "../agent";
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
    expect(isShortCatalogProductSelection("¿Tiene garantía?")).toBe(false);
    expect(isShortCatalogProductSelection("¿Cuánto cuesta?")).toBe(false);
    expect(isShortCatalogProductSelection("Gracias")).toBe(false);
    expect(isShortCatalogProductSelection("¿Qué tienes en venta?")).toBe(false);
    expect(isShortCatalogProductSelection("A16")).toBe(true);
    expect(isShortCatalogProductSelection("Un A16")).toBe(true);
    expect(isShortCatalogProductSelection("El Samsung A16")).toBe(true);
  });

  it("resolves a natural short phone selection such as 'Un A16' from the exact listing", () => {
    const context = [{
      text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM\nCategoría: Telefonía\nPrecio publicado: 190 USD\nDisponibilidad publicada: Disponible",
    }];
    const reply = buildShortCatalogProductSelectionReply("Un A16", context, sync, now);
    expect(reply).toContain("SAMSUNG GALAXY A16");
    expect(reply).toContain("190 USD");
    expect(reply).toContain("existencia física debe confirmarse");
  });

  it("resolves a short selection for a real non-phone listing from its own catalog title", () => {
    const context = [{ text: "PRODUCTO: BLUETTI ELITE 100 V2 – ESTACIÓN DE ENERGÍA PORTÁTIL DE 1024Wh / 1800W\nCategoría: Energía\nPrecio publicado: 600 USD\nDisponibilidad publicada: Disponible" }];
    const reply = buildShortCatalogProductSelectionReply("Una Bluetti", context, sync, now);
    expect(reply).toContain("BLUETTI ELITE 100 V2");
    expect(reply).toContain("600 USD");
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
    const productQuery = resolveRecentProductQuery("Características del teléfono", thread);
    expect(productQuery).toBe("Un A16");
    const reply = buildUniversalCatalogTechnicalReply("Características del teléfono", productQuery, context, sync, now);
    expect(reply).toContain("SAMSUNG GALAXY A16");
    expect(reply).toContain("RAM: 4 GB");
  });

  it("does not revive an older product after the customer starts a new catalog search", () => {
    const context = [{ text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM" }];
    const thread = "[Previous messages]\nCustomer: Un A16\nAgent: El A16 aparece en catálogo\nCustomer: ¿Qué tienes en venta?\nAgent: Tenemos varios productos";
    const productQuery = resolveRecentProductQuery("¿Qué propiedades tiene?", thread);
    expect(productQuery).toBe("¿Qué tienes en venta?");
    const reply = buildUniversalCatalogTechnicalReply("¿Qué propiedades tiene?", productQuery, context, sync, now);
    expect(reply).toBeNull();
  });

  it("does not fall back to an older phone when the customer names a different ambiguous brand", () => {
    const context = [
      { text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM" },
      { text: "PRODUCTO: ECOFLOW DELTA 2 — 1024Wh" },
      { text: "PRODUCTO: ECOFLOW RIVER 2 PRO — 768Wh" },
    ];
    const reply = buildUniversalCatalogTechnicalReply("¿Qué potencia tiene la EcoFlow?", "¿Qué potencia tiene la EcoFlow?", context, sync, now);
    expect(reply).toBeNull();
  });

  it("switches to a newly named catalog product even when its brand was never hard-coded", () => {
    const context = [
      { text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM" },
      { text: "PRODUCTO: BLUETTI ELITE 100 V2 – ESTACIÓN DE ENERGÍA PORTÁTIL DE 1024Wh / 1800W\nCategoría: Energía\nCapacidad de batería: 1024Wh\nPotencia nominal: 1800W\nPotencia pico: 3600W" },
    ];
    const reply = buildUniversalCatalogTechnicalReply(
      "¿Qué potencia tiene la Bluetti?",
      "Un A16",
      context,
      sync,
      now,
    );
    expect(reply).toContain("BLUETTI ELITE 100 V2");
    expect(reply).toContain("1800W");
    expect(reply).not.toContain("SAMSUNG GALAXY A16");
  });

  it("keeps the active product for a technical follow-up that does not repeat its name", () => {
    const context = [
      { text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM" },
      { text: "PRODUCTO: BLUETTI ELITE 100 V2\nPotencia: 1800W" },
    ];
    const reply = buildUniversalCatalogTechnicalReply(
      "¿Qué potencia tiene?",
      "Un A16",
      context,
      sync,
      now,
    );
    expect(reply).toContain("SAMSUNG GALAXY A16");
    expect(reply).not.toContain("BLUETTI");
  });

  it("extracts EcoFlow Delta 2 specifications from the live listing description format", () => {
    const description = [
      "¿Los apagones ya no son un problema? La EcoFlow DELTA 2 combina potencia, carga ultrarrápida y batería de larga duración.",
      "Especificaciones destacadas:",
      "- Capacidad: 1024 Wh (1 kWh)",
      "- Potencia: 1800 W continuos / hasta 2700 W pico con X-Boost",
      "- Batería LiFePO4: más de 3000 ciclos de carga",
      "- Carga solar: admite hasta 500 W",
      "- Carga ultrarrápida: 0–80 % en aproximadamente 50 minutos",
      "- Control inteligente: Wi-Fi y Bluetooth con la app EcoFlow",
      "Amplía tu autonomía",
      "Compatible con batería adicional de 1024 Wh, que permite alcanzar una capacidad total de 2048 Wh (2 kWh).",
      "Ideal para hogar y negocio:",
      "- Neveras y ventiladores",
      "- Equipos compatibles de hasta 1800 W",
    ].join("\n");
    const context = [{
      text: "PRODUCTO: ECOFLOW DELTA 2 | Energía inteligente para tu hogar y negocio\nCategoría: Energía\nPrecio publicado: 800 USD\nDescripción y características publicadas: " + description + "\nFicha pública: https://revolico-sagua.pages.dev/anuncio/96981f24-b324-4a8e-9fd4-c218bd3db3f1",
    }];
    const reply = buildUniversalCatalogTechnicalReply("Dime las propiedades del EcoFlow", "Dime las propiedades del EcoFlow", context, sync, now);
    expect(reply).toContain("1024 Wh");
    expect(reply).toContain("1800 W continuos");
    expect(reply).toContain("2700 W pico");
    expect(reply).toContain("LiFePO4");
    expect(reply).toContain("500 W");
    expect(reply).toContain("50 minutos");
    expect(reply).toContain("Wi-Fi y Bluetooth");
    expect(reply).toContain("2048 Wh");
  });
  it("answers an energy station from its published capacity and power fields", () => {
    const context = [{ text: "PRODUCTO: ECOFLOW DELTA 2 — 1024Wh\nCategoría: Estaciones de energía\nPotencia: 1800W\nQuímica de batería: LiFePO4" }];
    const reply = buildUniversalCatalogTechnicalReply("¿Qué potencia y capacidad tiene?", "EcoFlow Delta 2", context, sync, now);
    expect(reply).toContain("1024 Wh");
    expect(reply).toContain("1800W");
    expect(reply).toContain("LiFePO4");
  });

  it("answers apparel questions from published size, material and color fields", () => {
    const context = [{ text: "PRODUCTO: CAMISETA ALGODÓN\nCategoría: Ropa\nTalla: M\nMaterial: 100% algodón\nColor: Negro" }];
    const reply = buildUniversalCatalogTechnicalReply("¿Qué talla y material tiene la camiseta?", "¿Qué talla y material tiene la camiseta?", context, sync, now);
    expect(reply).toContain("Talla: M");
    expect(reply).toContain("Material: 100% algodón");
    expect(reply).toContain("Color: Negro");
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

  it("keeps an elliptical 5G question attached to the active product instead of matching another 5G listing", () => {
    const context = [
      { text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM" },
      { text: "PRODUCTO: SAMSUNG GALAXY A56 5G — 8GB RAM / 256GB ROM" },
    ];
    const reply = buildUniversalCatalogTechnicalReply("¿Es 5G?", "Un A16", context, sync, now);
    expect(reply).toContain("SAMSUNG GALAXY A16");
    expect(reply).toContain("no especifica la conectividad de red");
    expect(reply).not.toContain("A56");
  });

  it("does not confuse a short model code with a longer one", () => {
    const context = [{ text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM" }];
    const reply = buildUniversalCatalogTechnicalReply("¿Qué características tiene?", "A1", context, sync, now);
    expect(reply).toBeNull();
  });
});
