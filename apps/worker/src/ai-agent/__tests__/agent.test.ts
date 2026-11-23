import { describe, it, expect } from "vitest";
import { buildCatalogPriceReply, buildPhoneBundleReply, buildStorePolicyOnlyReply, parseToolArgs } from "../agent";

describe("parseToolArgs", () => {
  it("passes objects through", () => {
    expect(parseToolArgs({ orderId: "1" })).toEqual({ orderId: "1" });
  });

  it("parses JSON strings", () => {
    expect(parseToolArgs('{"reason":"urgent"}')).toEqual({ reason: "urgent" });
    expect(parseToolArgs('"just a string"')).toEqual({});
  });

  it("returns {} for garbage and undefined", () => {
    expect(parseToolArgs("not json")).toEqual({});
    expect(parseToolArgs(undefined)).toEqual({});
    expect(parseToolArgs(null)).toEqual({});
    expect(parseToolArgs(42)).toEqual({});
  });
});

describe("phone bundle replies", () => {
  const phoneContext = [{
    id: "f07",
    source: "revolico-sagua.pages.dev (catalog)",
    score: 1,
    text: ["PRODUCTO: SAMSUNG GALAXY F07 — 4GB RAM / 64GB ROM", "Precio publicado: 150 USD"].join("\n"),
  }];

  it("answers accessories and warranty from permanent policy without a Knowledge policy chunk", () => {
    expect(buildPhoneBundleReply("¿Qué incluye la compra del Samsung F07 y cuántos días de garantía tiene?", phoneContext))
      .toBe("La compra de SAMSUNG GALAXY F07 — 4GB RAM / 64GB ROM incluye cover de fábrica, cable, cargador original y mica protectora de cristal templado. Además, cuenta con 15 días de garantía.");
    expect(buildPhoneBundleReply("¿Cuántos días de garantía tiene el F07?", phoneContext)).toContain("15 días de garantía");
  });

  it("does not apply phone accessories to energy stations or other products", () => {
    const energyContext = [{ ...phoneContext[0], text: "PRODUCTO: ECOFLOW DELTA 2 — 1024Wh" }];
    expect(buildPhoneBundleReply("¿Qué incluye la compra de DELTA 2?", energyContext)).toBeNull();
  });

  it("does not answer for a model absent from the retrieved catalog", () => {
    expect(buildPhoneBundleReply("¿Qué incluye el Samsung A07?", phoneContext)).toBeNull();
  });
});

describe("catalog price replies", () => {
  const now = Date.parse("2026-11-23T10:00:00Z");
  const context = [{
    id: "f07",
    source: "revolico-sagua.pages.dev (catalog)",
    score: 1,
    text: [
      "CATÁLOGO PÚBLICO DE CELL PHONE STORE",
      "PRODUCTO: SAMSUNG GALAXY F07 — 4GB RAM / 64GB ROM",
      "Precio publicado: 150 USD",
      "Disponibilidad publicada: Disponible",
    ].join("\n"),
  }];
  const freshSync = { stage: "completed", updatedAt: "2026-11-23T09:55:00Z" };

  it("answers a specific model price from a fresh catalog chunk without model generation", () => {
    expect(buildCatalogPriceReply("¿Cuánto cuesta el F07?", context, freshSync, now))
      .toBe("El precio publicado de SAMSUNG GALAXY F07 — 4GB RAM / 64GB ROM es 150 USD. La disponibilidad física debe confirmarse directamente con el vendedor.");
  });

  it("does not answer from an old or incomplete synchronization", () => {
    expect(buildCatalogPriceReply("¿Cuánto cuesta el F07?", context, { stage: "homepage_read", updatedAt: freshSync.updatedAt }, now)).toBeNull();
    expect(buildCatalogPriceReply("¿Cuánto cuesta el F07?", context, { stage: "completed", updatedAt: "2026-11-23T09:00:00Z" }, now)).toBeNull();
  });

  it("does not guess when the requested product or price is absent", () => {
    expect(buildCatalogPriceReply("¿Cuánto cuesta el A07?", context, freshSync, now)).toBeNull();
    expect(buildCatalogPriceReply("¿Cuánto cuesta el F07?", [{ ...context[0], text: context[0].text.replace("Precio publicado: 150 USD", "") }], freshSync, now)).toBeNull();
  });
});


describe("store policy-only replies", () => {
  it("answers EcoFlow inclusion questions without claiming a model is listed", () => {
    const reply = buildStorePolicyOnlyReply("¿Qué incluye la EcoFlow DELTA 2?");
    expect(reply).toContain("únicamente la caja y la unidad principal");
    expect(reply).toContain("no hay baterías extra disponibles");
    expect(reply).toContain("no puedo confirmar");
  });

  it("answers EcoFlow delivery and warranty questions from approved policy", () => {
    expect(buildStorePolicyOnlyReply("¿La EcoFlow tiene entrega a domicilio?")).toContain("entrega a domicilio");
    expect(buildStorePolicyOnlyReply("¿Qué garantía tiene EcoFlow?")).toContain("no tienen garantía comercial");
  });

  it("explains motorcycle order and international warranty limitations", () => {
    const reply = buildStorePolicyOnlyReply("¿Qué garantía tienen las motocicletas?");
    expect(reply).toContain("corresponde al fabricante");
    expect(reply).toContain("transporte podría correr por cuenta del cliente");
  });

  it("does not answer availability or unrelated questions from policy alone", () => {
    expect(buildStorePolicyOnlyReply("¿Tienen EcoFlow en venta?")).toBeNull();
    expect(buildStorePolicyOnlyReply("¿Cuánto cuesta la moto?")).toBeNull();
    expect(buildStorePolicyOnlyReply("Hola")).toBeNull();
  });
});
