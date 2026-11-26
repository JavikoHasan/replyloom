import { describe, it, expect } from "vitest";
import { handleAgentMessage, buildAssistantIdentityReply, buildBusinessContactReply, buildZelleTotalReply, buildCatalogLookupReply, buildCatalogPriceReply, buildPhoneBundleReply, buildPaymentPolicyReply, buildStorePolicyOnlyReply, buildCatalogDeliveryReply, buildGeneralDeliveryPolicyReply, buildPhoneTechnicalReply, buildReservationPolicyReply, buildPurchaseInterestReply, isPurchaseInterestMessage, isPhoneFunctionalityQuestion, resolveRecentProductQuery, isDeliveryQuestion, isDeliverySchedulingQuestion, isCatalogLookupQuestion, isSimpleGreeting, normalizeGeneratorResult, parseToolArgs } from "../agent";
import { queryTerms, shouldFallbackToCatalog } from "../rag";

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
      .toBe("La compra de SAMSUNG GALAXY F07 — 4GB RAM / 64GB ROM incluye cover de fábrica, mica protectora de cristal templado, cable USB y cargador original. Además, cuenta con 15 días de garantía.");
    expect(buildPhoneBundleReply("¿Cuántos días de garantía tiene el F07?", phoneContext)).toContain("15 días de garantía");
  });

  it("answers generic phone warranty and accessory follow-ups when the recent conversation was about phones", () => {
    const reply = buildPhoneBundleReply("¿Qué garantía tienen?", [], "Hola, ¿tienes teléfonos?");
    expect(reply).toContain("15 días de garantía");
    expect(reply).toContain("cable USB y cargador original");
    expect(buildPhoneBundleReply("¿Qué accesorios trae?", [], "Estos son los teléfonos publicados")).toContain("cover de fábrica");
    expect(buildPhoneBundleReply("¿Qué garantía tienen?", [], "¿Tienes estaciones de energía?")).toBeNull();
  });

  it("does not apply phone accessories to energy stations or other products", () => {
    const energyContext = [{ ...phoneContext[0], text: "PRODUCTO: ECOFLOW DELTA 2 — 1024Wh" }];
    expect(buildPhoneBundleReply("¿Qué incluye la compra de DELTA 2?", energyContext)).toBeNull();
  });

  it("does not answer for a model absent from the retrieved catalog", () => {
    expect(buildPhoneBundleReply("¿Qué incluye el Samsung A07?", phoneContext)).toBeNull();
  });
});

describe("catalog inventory and model availability replies", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const sync = { stage: "completed", updatedAt: "2026-11-24T11:55:00Z" };
  const catalog = [
    {
      id: "phone-1",
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
      id: "phone-2",
      source: "revolico-sagua.pages.dev (catalog)",
      score: 1,
      text: [
        "PRODUCTO: SAMSUNG GALAXY A17 — 4GB RAM / 128GB ROM",
        "Categoría: Telefonía",
        "Precio publicado: 190 USD",
        "Disponibilidad publicada: Disponible",
      ].join("\n"),
    },
    {
      id: "energy-1",
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

  it("recognizes model lookups and broad inventory questions", () => {
    expect(isCatalogLookupQuestion("¿Tienes F07?")).toBe(true);
    expect(isCatalogLookupQuestion("¿Qué teléfonos tienen en venta?")).toBe(true);
    expect(isCatalogLookupQuestion("¿Cuáles son las cosas que vendes?")).toBe(true);
    expect(isCatalogLookupQuestion("¿Qué vendes?")).toBe(true);
    expect(isCatalogLookupQuestion("¿Tienes estaciones de energía?")).toBe(true);
    expect(isCatalogLookupQuestion("¿Tienes motos?")).toBe(true);
    expect(isCatalogLookupQuestion("¿Qué procesador tiene el F07?")).toBe(false);
    expect(isCatalogLookupQuestion("¿Qué cámara tiene el F07?")).toBe(false);
  });

  it("answers a specific motorcycle model lookup instead of listing every motorcycle", () => {
    const motorcycleCatalog = [{
      id: "moto-1", source: "revolico-sagua.pages.dev (catalog)", score: 1,
      text: ["PRODUCTO: IZUKI HURACAN 250cc", "Categoría: Motocicletas", "Precio publicado: 2700 USD", "Disponibilidad publicada: Por encargo"].join("\n"),
    }, {
      id: "moto-2", source: "revolico-sagua.pages.dev (catalog)", score: 1,
      text: ["PRODUCTO: XMX 250cc", "Categoría: Motocicletas", "Precio publicado: 3000 USD", "Disponibilidad publicada: Por encargo"].join("\n"),
    }];
    const reply = buildCatalogLookupReply("Me interesa la moto izuki", motorcycleCatalog, sync, now);
    expect(reply).toContain("IZUKI HURACAN 250cc");
    expect(reply).toContain("2700 USD");
    expect(reply).not.toContain("XMX");
    expect(buildPurchaseInterestReply("Me interesa la moto izuki", reply)).toContain("WhatsApp");
  });

  it("recognizes the common misspelling isuki as IZUKI", () => {
    const query = resolveRecentProductQuery("Características de la moto isuki", "Customer: ¿Tienes teléfonos?");
    expect(query).toContain("isuki");
    expect(buildPhoneTechnicalReply("Características de la moto isuki", query, [{
      id: "moto-1", source: "revolico-sagua.pages.dev (catalog)", score: 1,
      text: "PRODUCTO: IZUKI HURACAN 250cc\nCategoría: Motocicletas",
    }], sync, now)).toContain("IZUKI HURACAN 250cc");
  });

  it("does not mix previous phone context into an energy-station delivery follow-up", () => {
    const message = "¿Y la entrega de las estaciones cómo es?";
    const thread = "Customer: ¿Cómo se realiza la entrega de los celulares?\nCustomer: ¿Tienes estaciones de energía?";
    expect(resolveRecentProductQuery(message, thread)).toBe(message);
    const reply = buildGeneralDeliveryPolicyReply(message, "¿Tienes estaciones de energía?");
    expect(reply).toContain("Bluetti Elite 100 V2");
    expect(reply).not.toContain("motorina eléctrica");
  });

  it("lists only the motorcycles present in the published catalog", () => {
    const motorcycleCatalog = [{
      id: "moto-1",
      source: "revolico-sagua.pages.dev (catalog)",
      score: 1,
      text: ["PRODUCTO: IZUKI HURACAN 250cc", "Categoría: Motocicletas", "Disponibilidad publicada: Por encargo"].join("\n"),
    }, {
      id: "moto-2",
      source: "revolico-sagua.pages.dev (catalog)",
      score: 1,
      text: ["PRODUCTO: XMX 250cc", "Categoría: Motocicletas", "Disponibilidad publicada: Por encargo"].join("\n"),
    }];
    const reply = buildCatalogLookupReply("¿Tienes motos?", motorcycleCatalog, sync, now);
    expect(reply).toContain("motocicletas");
    expect(reply).toContain("IZUKI HURACAN 250cc");
    expect(reply).toContain("XMX 250cc");
  });

  it("does not offer the A07 because it is absent from the live catalog", () => {
    const reply = buildCatalogLookupReply("¿Tienes A07?", catalog, sync, now);
    expect(reply?.toLowerCase()).toContain("no encuentro un anuncio vigente");
    expect(reply).not.toContain("SAMSUNG GALAXY F07");
  });

  it("confirms an exact model only from its own current listing", () => {
    const reply = buildCatalogLookupReply("¿Tienes Samsung F07?", catalog, sync, now);
    expect(reply).toContain("SAMSUNG GALAXY F07");
    expect(reply).toContain("150 USD");
    expect(reply).toContain("Disponible");
    expect(reply).toContain("confirmarse directamente con el vendedor");
  });

  it("lists all matching phones and their published prices", () => {
    const reply = buildCatalogLookupReply("¿Qué teléfonos tienen en venta?", catalog, sync, now);
    expect(reply).toContain("SAMSUNG GALAXY F07");
    expect(reply).toContain("SAMSUNG GALAXY A17");
    expect(reply).not.toContain("ECOFLOW DELTA 2");
  });

  it("lists EcoFlow products separately from phones", () => {
    const reply = buildCatalogLookupReply("¿Tienen estaciones de energía EcoFlow?", catalog, sync, now);
    expect(reply).toContain("ECOFLOW DELTA 2");
    expect(reply).not.toContain("SAMSUNG GALAXY F07");
  });

  it("filters a requested energy brand instead of returning unrelated EcoFlow products", () => {
    const oupesQuestion = "¿Tienes estaciones de energía marca Oupes?";
    expect(isCatalogLookupQuestion(oupesQuestion)).toBe(true);
    const reply = buildCatalogLookupReply(oupesQuestion, catalog, sync, now);
    expect(reply).toContain("marca OUPES");
    expect(reply).toContain("no encuentro anuncios vigentes");
    expect(reply).not.toContain("ECOFLOW DELTA 2");
    expect(isCatalogLookupQuestion("¿Tienes Oupes?")).toBe(true);
    expect(buildCatalogLookupReply("¿Tienes Oupes?", catalog, sync, now)).not.toContain("ECOFLOW DELTA 2");
  });

  it("lists all energy stations across brands instead of treating the category as EcoFlow-only", () => {
    const bluetti = {
      id: "energy-2",
      source: "revolico-sagua.pages.dev (catalog)",
      score: 1,
      text: ["PRODUCTO: BLUETTI ELITE 100 V2", "Categoría: Estaciones de energía", "Precio publicado: 600 USD", "Disponibilidad publicada: Disponible"].join("\\n"),
    };
    const reply = buildCatalogLookupReply("¿Tienes estaciones de energía?", [...catalog, bluetti], sync, now);
    expect(reply).toContain("ECOFLOW DELTA 2");
    expect(reply).toContain("BLUETTI ELITE 100 V2");
  });

  it("clearly states that phone cables and chargers are included, never sold separately", () => {
    for (const question of ["¿Tienes cable y cargador en venta?", "¿Venden cargadores sueltos?", "¿Cuánto cuesta el cable?"]) {
      expect(isCatalogLookupQuestion(question)).toBe(true);
      const reply = buildCatalogLookupReply(question, catalog, sync, now);
      expect(reply).toContain("No vendemos cables ni cargadores por separado");
      expect(reply).toContain("Se incluyen con la compra de cualquiera de nuestros teléfonos");
      expect(reply).not.toContain("anuncios independientes");
      expect(reply).not.toContain("ECOFLOW");
    }
  });

  it("recognizes product-category searches such as rechargeable lamps", () => {
    expect(isCatalogLookupQuestion("¿Tienes lámparas recargables?")).toBe(true);
    expect(isCatalogLookupQuestion("Lámparas recargables")).toBe(true);
    expect(isCatalogLookupQuestion("¿Qué potencia tiene la lámpara?")).toBe(false);
  });

  it("does not return the whole catalog for an unlisted product category", () => {
    const reply = buildCatalogLookupReply("¿Tienes lámparas recargables?", catalog, sync, now);
    expect(reply).toContain("no encuentro anuncios vigentes");
    expect(reply).toContain("lámparas recargables");
    expect(reply).not.toContain("SAMSUNG GALAXY F07");
    expect(reply).not.toContain("ECOFLOW DELTA 2");
  });

  it("filters new category searches against the product's published description", () => {
    const lamp = {
      id: "lamp-1", source: "revolico-sagua.pages.dev (catalog)", score: 1,
      text: "PRODUCTO: LÁMPARA LED RECARGABLE\nCategoría: Hogar\nDescripción y características publicadas: Lámpara de emergencia con batería recargable y luz LED.\nPrecio publicado: 25 USD",
    };
    const reply = buildCatalogLookupReply("¿Tienes lámparas recargables?", [...catalog, lamp], sync, now);
    expect(reply).toContain("LÁMPARA LED RECARGABLE");
    expect(reply).not.toContain("SAMSUNG GALAXY F07");
    expect(reply).not.toContain("ECOFLOW DELTA 2");
  });

  it("treats Samsung Galaxy S-series questions as a specific product family", () => {
    expect(isCatalogLookupQuestion("¿Tienes Galaxy de la serie S?")).toBe(true);
    const reply = buildCatalogLookupReply("¿Tienes Galaxy de la serie S?", catalog, sync, now);
    expect(reply).toContain("no encuentro anuncios vigentes");
    expect(reply).not.toContain("SAMSUNG GALAXY A17");
  });

  it("does not make inventory claims from stale or incomplete catalog syncs", () => {
    expect(buildCatalogLookupReply("¿Tienes F07?", catalog, { stage: "running", updatedAt: sync.updatedAt }, now)).toBeNull();
    expect(buildCatalogLookupReply("¿Tienes F07?", catalog, { stage: "completed", updatedAt: "2026-11-24T04:00:00Z" }, now)).toBeNull();
  });
});

describe("exact catalog model matching", () => {
  const sync = { stage: "completed", updatedAt: "2026-11-24T17:00:00.000Z" };
  const now = Date.parse("2026-11-24T17:05:00.000Z");

  it("does not match a short model identifier inside a longer model", () => {
    const a16 = [{ id: "a16", source: "catalog", score: 1, text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM\\nCategoría: Telefonía\\nPrecio publicado: 190 USD\\nDisponibilidad publicada: Disponible" }];
    expect(buildCatalogLookupReply("¿Tienes A1?", a16, sync, now)?.toLowerCase()).toContain("no encuentro un anuncio vigente");
    const a160 = [{ id: "a160", source: "catalog", score: 1, text: "PRODUCTO: SAMSUNG GALAXY A160 — 4GB RAM / 128GB ROM\\nCategoría: Telefonía\\nPrecio publicado: 190 USD\\nDisponibilidad publicada: Disponible" }];
    expect(buildCatalogLookupReply("¿Tienes A16?", a160, sync, now)?.toLowerCase()).toContain("no encuentro un anuncio vigente");
  });

  it("still matches the exact model in a longer product title", () => {
    const a16 = [{ id: "a16", source: "catalog", score: 1, text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM\\nCategoría: Telefonía\\nPrecio publicado: 190 USD\\nDisponibilidad publicada: Disponible" }];
    expect(buildCatalogLookupReply("¿Tienes A16?", a16, sync, now)).toContain("SAMSUNG GALAXY A16");
  });
});

describe("grounded motorcycle technical replies", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const sync = { stage: "completed", updatedAt: "2026-11-24T11:55:00Z" };
  it("reports only the verified 250cc title detail and does not invent specifications", () => {
    const reply = buildPhoneTechnicalReply("Características de la moto XMX", "Características de la moto XMX", [{
      id: "moto-2", source: "revolico-sagua.pages.dev (catalog)", score: 1,
      text: "PRODUCTO: XMX 250cc\nCategoría: Motocicletas",
    }], sync, now);
    expect(reply).toContain("XMX 250cc");
    expect(reply).toContain("250 cc");
    expect(reply).toContain("No aparecen otras especificaciones verificadas");
    expect(reply).not.toContain("potencia de");
  });

  it("uses explicit technical fields from the matching motorcycle listing", () => {
    const reply = buildPhoneTechnicalReply("Características de la moto XMX", "Características de la moto XMX", [{
      id: "moto-2", source: "revolico-sagua.pages.dev (catalog)", score: 1,
      text: "PRODUCTO: XMX 250cc\nPotencia: 18 HP\nTransmisión: 5 velocidades",
    }], sync, now);
    expect(reply).toContain("Potencia: 18 HP");
    expect(reply).toContain("Transmisión: 5 velocidades");
  });
});

describe("grounded energy station technical replies", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const sync = { stage: "completed", updatedAt: "2026-11-24T11:55:00Z" };
  const delta2 = [{
    id: "energy-delta-2",
    source: "revolico-sagua.pages.dev (catalog)",
    score: 1,
    text: [
      "PRODUCTO: ECOFLOW DELTA 2 — 1024Wh",
      "Categoría: Estaciones de energía",
      "Descripción: Potencia de salida 1800 W, batería LiFePO4 y capacidad ampliable hasta 2048Wh.",
    ].join("\n"),
  }];

  it("routes EcoFlow characteristics to technical details instead of the inventory list", () => {
    expect(isCatalogLookupQuestion("¿Qué características tiene la EcoFlow?")).toBe(false);
    expect(isCatalogLookupQuestion("¿Tienes EcoFlow?")).toBe(true);
    const reply = buildPhoneTechnicalReply("¿Qué características tiene la EcoFlow?", "¿Qué características tiene la EcoFlow?", delta2, sync, now);
    expect(reply).toContain("ECOFLOW DELTA 2");
    expect(reply).toContain("Capacidad: 1024 Wh");
    expect(reply).toContain("Potencia: 1800 W");
    expect(reply).toContain("Química de batería: LiFePO4");
    expect(reply).toContain("Capacidad ampliable: 2048Wh");
  });

  it("keeps a generic characteristics follow-up attached to the most recent EcoFlow, not an older motorcycle", () => {
    const thread = [
      "[Previous messages]",
      "Customer: ¿Qué características tiene la XMX?",
      "Agent: La XMX 250cc...",
      "Customer: ¿Qué características tiene la Isuki?",
      "Agent: La IZUKI HURACAN 250cc...",
      "Customer: ¿Qué características tiene la EcoFlow?",
      "Agent: Estos son los productos ECOFLOW...",
    ].join("\n");
    expect(resolveRecentProductQuery("¿Qué características tiene?", thread)).toBe("¿Qué características tiene la EcoFlow?");
    const reply = buildPhoneTechnicalReply(
      "¿Qué características tiene?",
      resolveRecentProductQuery("¿Qué características tiene?", thread),
      delta2,
      sync,
      now,
    );
    expect(reply).toContain("ECOFLOW DELTA 2");
    expect(reply).not.toContain("XMX");
    expect(reply).not.toContain("IZUKI");
  });

  it("does not borrow specifications from another energy brand or model", () => {
    const mixed = [...delta2, {
      id: "energy-bluetti",
      source: "revolico-sagua.pages.dev (catalog)",
      score: 1,
      text: "PRODUCTO: BLUETTI ELITE 100 V2\nCapacidad: 1024 Wh\nPotencia: 1800 W",
    }];
    const reply = buildPhoneTechnicalReply("¿Qué características tiene la EcoFlow?", "¿Qué características tiene la EcoFlow?", mixed, sync, now);
    expect(reply).toContain("ECOFLOW DELTA 2");
    expect(reply).not.toContain("BLUETTI");
  });
});

describe("grounded phone technical replies", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const sync = { stage: "completed", updatedAt: "2026-11-24T11:55:00Z" };
  const a16 = [{
    id: "a16",
    source: "revolico-sagua.pages.dev (catalog)",
    score: 1,
    text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM\nPrecio publicado: 190 USD",
  }];
  const a17 = [{
    id: "a17",
    source: "revolico-sagua.pages.dev (catalog)",
    score: 1,
    text: "PRODUCTO: SAMSUNG GALAXY A17 — 4GB RAM / 128GB ROM\nPrecio publicado: 200 USD",
  }];

  it("answers broad properties questions with only RAM and storage actually listed", () => {
    const reply = buildPhoneTechnicalReply("¿Qué propiedades tiene el A16?", "¿Qué propiedades tiene el A16?", a16, sync, now);
    expect(reply).toContain("4 GB de RAM");
    expect(reply).toContain("128 GB de almacenamiento interno");
    expect(reply).toContain("no quiero inventarlas");
  });

  it("requires an exact model identifier instead of matching a shorter model as a substring", () => {
    expect(buildPhoneTechnicalReply("¿Qué propiedades tiene el A1?", "¿Qué propiedades tiene el A1?", a16, sync, now)).toBeNull();
    const a160 = [{ ...a16[0], text: a16[0].text.replace("A16", "A160") }];
    expect(buildPhoneTechnicalReply("¿Qué propiedades tiene el A16?", "¿Qué propiedades tiene el A16?", a160, sync, now)).toBeNull();
  });

  it("does not infer 4G or 5G when the listing does not specify network generation", () => {
    const reply = buildPhoneTechnicalReply("¿El A17 es 4G o 5G?", "¿El A17 es 4G o 5G?", a17, sync, now);
    expect(reply).toContain("no especifica si es 4G o 5G");
  });

  it("reports a network generation only when explicitly present in the listing", () => {
    const a56 = [{
      ...a17[0],
      text: "PRODUCTO: SAMSUNG GALAXY A56 5G — 8GB RAM / 256GB ROM",
    }];
    const reply = buildPhoneTechnicalReply("¿El A56 es 4G o 5G?", "¿El A56 es 4G o 5G?", a56, sync, now);
    expect(reply).toContain("conectividad 5G");
  });

  it("does not answer from stale or incomplete catalog synchronization", () => {
    expect(buildPhoneTechnicalReply("¿Qué propiedades tiene el A16?", "A16", a16, { stage: "running", updatedAt: sync.updatedAt }, now)).toBeNull();
    expect(buildPhoneTechnicalReply("¿Qué propiedades tiene el A16?", "A16", a16, { stage: "completed", updatedAt: "2026-11-24T02:00:00Z" }, now)).toBeNull();
  });

  it("keeps a 4G/5G follow-up attached to the last actual phone model", () => {
    const thread = "[Previous messages]\nCustomer: ¿Tienes A17?\nAgent: Sí, aparece en catálogo.";
    expect(resolveRecentProductQuery("¿Y es 5G?", thread)).toBe("¿Tienes A17?");
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

  it("accepts a completed sync within the six-hour catalog refresh interval", () => {
    const syncFiveHoursAgo = { stage: "completed", updatedAt: "2026-11-23T05:00:00Z" };
    expect(buildCatalogPriceReply("¿Cuánto cuesta el F07?", context, syncFiveHoursAgo, now))
      .toContain("150 USD");
  });

  it("does not answer from an incomplete or excessively old synchronization", () => {
    expect(buildCatalogPriceReply("¿Cuánto cuesta el F07?", context, { stage: "homepage_read", updatedAt: freshSync.updatedAt }, now)).toBeNull();
    expect(buildCatalogPriceReply("¿Cuánto cuesta el F07?", context, { stage: "completed", updatedAt: "2026-11-23T02:59:00Z" }, now)).toBeNull();
  });

  it("does not guess when the requested product or price is absent", () => {
    expect(buildCatalogPriceReply("¿Cuánto cuesta el A07?", context, freshSync, now)).toBeNull();
    expect(buildCatalogPriceReply("¿Cuánto cuesta el F07?", [{ ...context[0], text: context[0].text.replace("Precio publicado: 150 USD", "") }], freshSync, now)).toBeNull();
  });
});


describe("payment policy routing", () => {
  it("answers the exact WhatsApp wording before intent classification", async () => {
    const config = {
      workspaceId: "store-workspace",
      enabled: true,
      businessName: "Cell Phone Store - Sagua la Grande",
      scopeDescription: "published store products and services",
      replyInGroups: false,
      models: { classifier: "classifier", generator: "generator", embedding: "embedding" },
      maxContextChunks: 4,
      similarityThreshold: 0.72,
      cacheTtlSeconds: 3600,
    };
    const reply = await handleAgentMessage({} as any, config, { message: "Aceptan pago por Zelle" });
    expect(reply.text).toContain("aceptamos Zelle");
    expect(reply.text).toContain("10%");
  });
});

describe("purchase-interest follow-ups", () => {
  it("recognizes clear interest phrases but not an ambiguous standalone yes", () => {
    expect(isPurchaseInterestMessage("Me interesa")).toBe(true);
    expect(isPurchaseInterestMessage("Estoy interesado")).toBe(true);
    expect(isPurchaseInterestMessage("Lo quiero")).toBe(true);
    expect(isPurchaseInterestMessage("Sí")).toBe(false);
  });

  it("continues the last exact A17 lookup with its published price and a safe seller handoff", () => {
    const query = "Quedan Galaxy A17";
    const catalogReply = "Sí, SAMSUNG GALAXY A17 — 4GB RAM / 128GB ROM aparece en nuestro catálogo. El precio publicado es 200 USD. El anuncio indica: Disponible. La existencia física debe confirmarse directamente con el vendedor.";
    const reply = buildPurchaseInterestReply(query, catalogReply);
    expect(reply).toContain("200 USD");
    expect(reply).toContain("existencia física");
    expect(reply).toContain("https://wa.me/5354590237");
  });

  it("does not claim a product is listed when the fresh catalog lookup found no listing", () => {
    const reply = buildPurchaseInterestReply("Quedan Galaxy A17", "No encuentro un anuncio vigente para A17.");
    expect(reply).toContain("debe confirmar");
    expect(reply).not.toContain("200 USD");
  });

  it("recognizes a functionality question only when a phone was discussed", () => {
    expect(isPhoneFunctionalityQuestion("Si funciona", "Quedan Galaxy A17")).toBe(true);
    expect(isPhoneFunctionalityQuestion("¿Funciona?", "¿Tienen EcoFlow?")).toBe(false);
  });
});

describe("reservation policy replies", () => {
  it("hands phone reservations to the seller without promising a hold", () => {
    const reply = buildReservationPolicyReply("¿Cómo puedo reservar uno?", "¿Tienes A17?");
    expect(reply).toContain("No puedo apartar ni garantizar una reserva");
    expect(reply).toContain("físicamente disponible");
    expect(reply).toContain("https://wa.me/5354590237");
  });

  it("keeps motorcycle reservations as an order inquiry, not a confirmed booking", () => {
    const reply = buildReservationPolicyReply("Quiero reservar una", "¿Cómo puedo encargar una moto?");
    expect(reply).toContain("por encargo a nombre del cliente");
    expect(reply).toContain("No puedo reservar ni formalizar el pedido");
    expect(reply).not.toContain("entrega en la puerta");
  });

  it("does not assume a product when reservation context is missing", () => {
    expect(buildReservationPolicyReply("Quiero reservar uno"))
      .toContain("No puedo formalizar ni garantizar reservas");
  });
});

describe("contextual delivery intelligence", () => {
  const sync = { stage: "completed", updatedAt: "2026-11-24T11:55:00Z" };
  const now = Date.parse("2026-11-24T12:00:00Z");
  const catalog = [{
    id: "f07-delivery",
    source: "revolico-sagua.pages.dev (catalog)",
    score: 1,
    text: [
      "PRODUCTO: SAMSUNG GALAXY F07 — 4GB RAM / 64GB ROM",
      "Categoría: Telefonía",
      "Precio publicado: 150 USD",
      "Disponibilidad publicada: Disponible",
      "Entrega publicada: Entrega a domicilio gratuita",
    ].join("\n"),
  }];

  it("recognizes delivery questions and carries the last product into a short follow-up", () => {
    expect(isDeliveryQuestion("¿Tienen servicio a domicilio?")).toBe(true);
    expect(resolveRecentProductQuery("¿Y la entrega?", "[Previous messages]\nCustomer: ¿Tienen F07?\nAgent: Sí, el F07 está publicado."))
      .toBe("¿Tienen F07?");
  });

  it("recognizes the three short delivery questions from the WhatsApp test", () => {
    for (const question of ["¿Tienen servicio a domicilio?", "¿Hay domicilio?", "¿Hay que pagar domicilio?"]) {
      expect(isDeliveryQuestion(question)).toBe(true);
    }
    const thread = "[Previous messages]\\nCustomer: ¿Tienes A16?\\nAgent: Sí, aparece en catálogo.";
    const contextQuery = resolveRecentProductQuery("¿Hay que pagar domicilio?", thread);
    expect(buildGeneralDeliveryPolicyReply("¿Hay que pagar domicilio?", contextQuery)).toContain("gratuita");
    expect(buildGeneralDeliveryPolicyReply("¿Hay domicilio?", contextQuery)).toContain("Sagua la Grande");
  });

  it("keeps a newly named model when the question also contains 4G or 5G", () => {
    const previousPhone = "[Previous messages]\\nCustomer: ¿Tienes A16?\\nAgent: Sí, aparece en catálogo.";
    expect(resolveRecentProductQuery("¿El A17 es 4G o 5G?", previousPhone)).toBe("¿El A17 es 4G o 5G?");
  });

  it("does not let an old phone model override a new EcoFlow category lookup", () => {
    const previousPhone = "[Previous messages]\\nCustomer: ¿Tienes F07?\\nAgent: Sí, aparece en catálogo.";
    expect(resolveRecentProductQuery("¿Tienes EcoFlow?", previousPhone)).toBe("¿Tienes EcoFlow?");
    expect(resolveRecentProductQuery("¿Tienes estaciones de energía?", previousPhone)).toBe("¿Tienes estaciones de energía?");
  });

  it("uses the newest category lookup instead of reviving an older phone for delivery follow-ups", () => {
    const thread = "[Previous messages]\nCustomer: ¿Tienes F07?\nAgent: Sí.\nCustomer: ¿Tienen estaciones de energía?\nAgent: Sí, aparece una EcoFlow.";
    expect(resolveRecentProductQuery("¿Hacen domicilio?", thread)).toBe("¿Tienen estaciones de energía?");
    expect(buildGeneralDeliveryPolicyReply("¿Hacen domicilio?", resolveRecentProductQuery("¿Hacen domicilio?", thread)))
      .toContain("estaciones EcoFlow anunciadas");
  });

  it("recognizes same-day and next-day delivery requests without promising a booking", () => {
    for (const question of ["Necesito uno mañana", "Quiero uno hoy", "Quiero uno para mañana", "¿Me lo pueden traer hoy?", "Quisiera que me traigan uno pasado mañana"]) {
      expect(isDeliverySchedulingQuestion(question)).toBe(true);
    }
    expect(isDeliverySchedulingQuestion("¿Tienen servicio a domicilio?")).toBe(false);
  });

  it("explains free delivery using the electric motorina and charging availability", () => {
    expect(buildCatalogDeliveryReply("F07", catalog, sync, now))
      .toContain("motorina eléctrica");
    expect(buildCatalogDeliveryReply("F07", catalog, sync, now))
      .toContain("disponibilidad de carga");
  });

  it("does not claim delivery when the listing says no home service", () => {
    const noDelivery = [{ ...catalog[0], text: catalog[0].text.replace("Entrega a domicilio gratuita", "No ofrece servicio a domicilio") }];
    expect(buildCatalogDeliveryReply("F07", noDelivery, sync, now)).toContain("no ofrece servicio a domicilio");
  });

  it("does not infer free delivery from a missing listing field", () => {
    const missing = [{ ...catalog[0], text: catalog[0].text.replace("Entrega publicada: Entrega a domicilio gratuita", "Entrega publicada: No especificada en la ficha") }];
    expect(buildCatalogDeliveryReply("F07", missing, sync, now)).toContain("no especifica claramente");
  });
});

describe("Zelle product follow-up totals", () => {
  const catalogReply = "Sí, SAMSUNG GALAXY F07 — 4GB RAM / 64GB ROM aparece en nuestro catálogo. El precio publicado es 150 USD. El anuncio indica: Disponible. La existencia física debe confirmarse directamente con el vendedor.";
  const zelleThread = "[Previous messages]\nCustomer: Aceptan pago por zelle?\nAgent: Sí, aceptamos Zelle para los anuncios publicados en USD. Se aplica un recargo del 10%.\nCustomer: F07";

  it("calculates the exact 10% surcharge when the customer names a product after asking about Zelle", () => {
    expect(buildZelleTotalReply(catalogReply, zelleThread))
      .toContain("Con el recargo del 10% por Zelle, el total es 165 USD.");
  });

  it("calculates the total when the current message explicitly asks for Zelle and names the product", () => {
    expect(buildZelleTotalReply(catalogReply, "[Previous messages]\nCustomer: F07", true))
      .toContain("el total es 165 USD");
  });

  it("does not add a Zelle total without a prior Zelle payment exchange", () => {
    expect(buildZelleTotalReply(catalogReply, "[Previous messages]\nCustomer: F07")).toBeNull();
    expect(buildZelleTotalReply(catalogReply, "Customer: ¿Aceptan Zelle?\nAgent: No tengo esa información")).toBeNull();
  });

  it("does not calculate when the catalog reply has no verified USD price", () => {
    expect(buildZelleTotalReply("El F07 aparece en catálogo.", zelleThread)).toBeNull();
  });
});

describe("payment policy replies", () => {
  it("answers a simple Zelle acceptance question without adding an unsolicited product total", () => {
    const reply = buildPaymentPolicyReply("Aceptan Zelle");
    expect(reply).toContain("aceptamos Zelle");
    expect(reply).toContain("10%");
    expect(reply).not.toContain("209 USD");
    expect(reply).not.toContain("190 USD");
  });

  it("answers CUP payment questions without suggesting an exchange rate", () => {
    expect(buildPaymentPolicyReply("¿Aceptan CUP?"))
      .toBe("No aceptamos efectivo en CUP ni transferencias en CUP para los anuncios publicados en USD. Los precios se mantienen en la moneda indicada en cada anuncio.");
  });

  it("explains the Zelle surcharge and offers an exact product total", () => {
    const reply = buildPaymentPolicyReply("¿Aceptan Zelle?");
    expect(reply).toContain("aceptamos Zelle");
    expect(reply).toContain("10%");
    expect(reply).toContain("total exacto");
  });

  it("recognizes natural Zelle payment paraphrases", () => {
    for (const question of [
      "¿Aceptan pago por Zelle?",
      "¿Puedo pagar usando Zelle?",
      "¿Se puede pagar con Zelle?",
      "Quiero pagar por Zelle",
      "¿Reciben Zelle como forma de pago?",
    ]) {
      expect(buildPaymentPolicyReply(question), question).toContain("10%");
    }
  });

  it("recognizes CUP payment paraphrases", () => {
    for (const question of [
      "¿Puedo pagar en moneda nacional?",
      "¿Reciben pesos cubanos?",
      "¿Aceptan transferencia en CUP?",
    ]) {
      expect(buildPaymentPolicyReply(question), question).toContain("No aceptamos");
    }
  });

  it("answers general payment questions only with approved terms", () => {
    expect(buildPaymentPolicyReply("¿Qué formas de pago aceptan?")).toContain("Zelle");
    expect(buildPaymentPolicyReply("¿Cuánto es el cambio?")).toContain("No ofrecemos una tasa fija");
  });
});

describe("additional payment language", () => {
  it("does not invent acceptance of USD cash or USD bank transfers", () => {
    expect(buildPaymentPolicyReply("¿Aceptas USD?")).toContain("No puedo confirmar efectivo ni otras modalidades");
    expect(buildPaymentPolicyReply("¿Aceptas transferencias en USD?")).toContain("no tengo confirmada la aceptación");
    expect(buildPaymentPolicyReply("¿Cuánto sería eso en transferencia?")).toContain("transferencias en USD no están confirmadas");
  });
  it("answers dollar-rate questions without estimating a conversion", () => {
    expect(buildPaymentPolicyReply("¿A cómo valoras el dólar?")).toContain("No ofrecemos una tasa fija");
  });
});

describe("category-level delivery replies", () => {
  it("recognizes requests to bring a product to the customer's address", () => {
    expect(isDeliveryQuestion("Tráeme un teléfono a esta dirección")).toBe(true);
    expect(buildGeneralDeliveryPolicyReply("Tráeme un teléfono a esta dirección")).toContain("No envíes tu dirección a este asistente");
    expect(buildGeneralDeliveryPolicyReply("Tráeme un teléfono a esta dirección")).toContain("https://wa.me/5354590237");
    expect(buildGeneralDeliveryPolicyReply("Tráeme un teléfono a esta dirección")).toContain("modelo o producto");
    expect(buildGeneralDeliveryPolicyReply("Tráeme un teléfono a esta dirección")).toContain("cantidad exacta");
    expect(buildGeneralDeliveryPolicyReply("¿Te puedo dejar mi dirección para que me lleves el A17?")).toContain("https://wa.me/5354590237");
    expect(buildGeneralDeliveryPolicyReply("Te puedo dejar mi dirección y se la pasas al dueño para que cuando esté disponible me traiga el teléfono?")).toContain("No envíes tu dirección a este asistente");
  });
  it("does not extend EcoFlow free delivery to Bluetti in a broad energy-station follow-up", () => {
    const reply = buildGeneralDeliveryPolicyReply("¿Cómo es la entrega?", "¿Tienes estaciones de energía?");
    expect(reply).toContain("EcoFlow");
    expect(reply).toContain("Bluetti Elite 100 V2");
    expect(reply).toContain("modalidad de entrega confirmada");
  });

  it("answers delivery questions without inventing a fee", () => {
    expect(buildGeneralDeliveryPolicyReply("¿Cuánto cuesta el domicilio de los teléfonos?")).toContain("es gratuita");
    expect(buildGeneralDeliveryPolicyReply("¿Cómo es el domicilio de las EcoFlow?")).toContain("gratuita");
    expect(buildGeneralDeliveryPolicyReply("¿Cuánto cuesta el domicilio?")).toContain("deben confirmarse en su anuncio o directamente con el vendedor");
  });
});

describe("store policy-only replies", () => {
  it("answers EcoFlow inclusion questions without claiming a model is listed", () => {
    const reply = buildStorePolicyOnlyReply("¿Qué incluye la EcoFlow DELTA 2?");
    expect(reply).toContain("únicamente la caja y la unidad principal");
    expect(reply).toContain("no hay baterías extra disponibles");
    expect(reply).toMatch(/no puedo confirmar/i);
  });

  it("answers EcoFlow delivery and warranty questions from approved policy", () => {
    expect(buildStorePolicyOnlyReply("¿La EcoFlow tiene entrega a domicilio?")).toContain("entrega a domicilio");
    expect(buildStorePolicyOnlyReply("¿Qué garantía tiene EcoFlow?")).toContain("no tienen garantía comercial");
  });

  it("uses recent product category for short EcoFlow warranty follow-ups", () => {
    const reply = buildStorePolicyOnlyReply("¿Qué garantía tienen?", "¿Tienes estaciones de energía?");
    expect(reply).toContain("no tienen garantía comercial");
    expect(reply).toContain("Bluetti Elite 100 V2");
    expect(reply).toContain("no tengo condiciones de garantía verificadas");
  });

  it("does not invent motorcycle warranty coverage", () => {
    const reply = buildStorePolicyOnlyReply("¿Qué garantía tienen las motocicletas?");
    expect(reply).toContain("No tengo condiciones de garantía verificadas");
    expect(reply).not.toContain("corresponde al fabricante");
  });

  it("explains the motorcycle order process without inventing deposits or dates", () => {
    const reply = buildStorePolicyOnlyReply("¿Cómo es el proceso de encargo de las motos?");
    expect(reply).toContain("a nombre del propio cliente");
    expect(reply).toContain("No puedo confirmar ni formalizar una reserva, anticipo, plazo ni fecha de llegada");
  });
  it("answers motorcycle delivery and warranty questions together", () => {
    const reply = buildStorePolicyOnlyReply("¿Cómo es el servicio de entrega y garantía de las motos?");
    expect(reply).toContain("Entrega:");
    expect(reply).toContain("Garantía:");
    expect(reply).toContain("no tengo confirmada la modalidad de entrega");
    expect(reply).toContain("no tengo condiciones de garantía verificadas");
    expect(reply).toContain("https://wa.me/5354590237");
  });

  it("does not promise motorcycle home delivery or an unverified warranty", () => {
    expect(buildStorePolicyOnlyReply("¿Las motos las entregan en la casa?"))
      .toContain("No tengo confirmada la modalidad de entrega");
    expect(buildStorePolicyOnlyReply("¿Cómo entregan las motocicletas?"))
      .toContain("debe confirmar si existe entrega a domicilio");
    expect(buildGeneralDeliveryPolicyReply("¿Cómo entregan las motos?"))
      .toContain("no puedo prometer entrega a domicilio");
  });
  it("declines customer sales and swaps", () => {
    expect(buildStorePolicyOnlyReply("Te vendo este teléfono")).toContain("no compra artículos a clientes");
    expect(buildStorePolicyOnlyReply("Te cambio esto y un vuelto por el F07")).toContain("no realizamos permutas");
  });

  it("does not answer availability or unrelated questions from policy alone", () => {
    expect(buildStorePolicyOnlyReply("¿Tienen EcoFlow en venta?")).toBeNull();
    expect(buildStorePolicyOnlyReply("¿Cuánto cuesta la moto?")).toBeNull();
    expect(buildStorePolicyOnlyReply("Hola")).toBeNull();
  });
});


describe("natural Spanish greeting recognition", () => {
  it("recognizes greetings with punctuation and time-of-day", () => {
    expect(isSimpleGreeting("Hola, buenas tardes.")).toBe(true);
    expect(isSimpleGreeting("¡Hola!")).toBe(true);
    expect(isSimpleGreeting("Ola buenas tardes")).toBe(true);
    expect(isSimpleGreeting("Buenas noches")).toBe(true);
    expect(isSimpleGreeting("Buenos días.")).toBe(true);
  });

  it("does not mistake commercial questions for greetings", () => {
    expect(isSimpleGreeting("¿Qué productos tienen a la venta?")).toBe(false);
    expect(isSimpleGreeting("¿Me pueden ayudar a comprar un equipo?")).toBe(false);
  });
});

describe("Spanish catalog query normalization", () => {
  it("singularizes common plural words to match catalog headings", () => {
    expect(queryTerms("¿Qué productos tienen a la venta?")).toContain("producto");
    expect(queryTerms("¿Qué anuncios tienen publicados?")).toContain("anuncio");
    expect(queryTerms("¿Tienen teléfonos disponibles?")).toContain("telefono");
  });
  it("normalizes the common IZUKI typo without fuzzy-matching product codes", () => {
    expect(resolveRecentProductQuery("Características de la moto isuki", "")).toContain("isuki");
    expect(buildCatalogLookupReply("Me interesa la moto isuki", [{
      id: "moto-1", source: "revolico-sagua.pages.dev (catalog)", score: 1,
      text: "PRODUCTO: IZUKI HURACAN 250cc\nCategoría: Motocicletas\nPrecio publicado: 2700 USD",
    }], { stage: "completed", updatedAt: "2026-11-24T11:55:00Z" }, Date.parse("2026-11-24T12:00:00Z"))).toContain("IZUKI HURACAN 250cc");
  });

});

describe("catalog fallback for natural-language wording", () => {
  it("uses verified store catalog chunks when wording does not match and no model is named", () => {
    expect(shouldFallbackToCatalog("revolico-sagua.pages.dev", [], 0)).toBe(true);
  });

  it("keeps exact model protection when a model identifier is present", () => {
    expect(shouldFallbackToCatalog("revolico-sagua.pages.dev", ["f07"], 0)).toBe(false);
  });

  it("does not use store catalog fallback for other businesses", () => {
    expect(shouldFallbackToCatalog(undefined, [], 0)).toBe(false);
  });

  it("does not need fallback when matching catalog rows already exist", () => {
    expect(shouldFallbackToCatalog("revolico-sagua.pages.dev", [], 2)).toBe(false);
  });
});

describe("normalizeGeneratorResult", () => {
  it("reads the legacy Workers AI response shape", () => {
    expect(normalizeGeneratorResult({ response: "  Hola  " })).toEqual({
      response: "Hola",
      toolCalls: [],
      format: "legacy",
    });
  });

  it("reads Gemma 4 OpenAI-compatible message content", () => {
    expect(normalizeGeneratorResult({
      choices: [{ message: { role: "assistant", content: "  El F07 cuesta 150 USD.  " } }],
    })).toEqual({
      response: "El F07 cuesta 150 USD.",
      toolCalls: [],
      format: "openai",
    });
  });

  it("extracts OpenAI-compatible function calls and preserves their raw envelope", () => {
    const args = JSON.stringify({ model: "F07" });
    const rawCall = {
      id: "call_123",
      type: "function",
      function: { name: "lookup", arguments: args },
    };
    expect(normalizeGeneratorResult({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [rawCall] } }],
    })).toEqual({
      response: "",
      toolCalls: [{ name: "lookup", arguments: args, raw: rawCall }],
      format: "openai",
    });
  });

  it("keeps the legacy top-level tool-call shape", () => {
    const rawCall = { name: "lookup", arguments: { model: "F07" } };
    expect(normalizeGeneratorResult({ tool_calls: [rawCall] }).toolCalls).toEqual([
      { name: "lookup", arguments: { model: "F07" }, raw: rawCall },
    ]);
  });

  it("joins text blocks from structured message content", () => {
    expect(normalizeGeneratorResult({
      choices: [{ message: { content: [{ type: "text", text: "Hola" }, { type: "text", text: " mundo" }] } }],
    }).response).toBe("Hola mundo");
  });
});


describe("assistant identity", () => {
  it("answers who the assistant is without turning into a general-purpose chatbot", () => {
    expect(buildAssistantIdentityReply("¿Eres una IA?")).toContain("Sí, soy el asistente virtual");
    expect(buildAssistantIdentityReply("¿Con quién hablo?")).toContain("Cell Phone Store - Sagua la Grande");
    expect(buildAssistantIdentityReply("Cuéntame un chiste")).toBeNull();
  });
});

describe("business contact and payment follow-ups", () => {
  it("returns the official WhatsApp contact for short contact questions", () => {
    expect(buildBusinessContactReply("Contacto")).toContain("https://wa.me/5354590237");
    expect(buildBusinessContactReply("¿Cómo puedo contactarlos?")).toContain("https://wa.me/5354590237");
    expect(buildBusinessContactReply("¿Cuál es el teléfono del vendedor?")).toContain("https://wa.me/5354590237");
    expect(buildBusinessContactReply("¿Qué teléfonos tienen?")).toBeNull();
    expect(buildBusinessContactReply("¿Qué características tiene el F07?")).toBeNull();
  });

  it("does not claim that PayPal or cryptocurrencies are accepted", () => {
    expect(buildPaymentPolicyReply("¿Aceptan PayPal?")).toContain("No tengo confirmación");
    expect(buildPaymentPolicyReply("¿Aceptan criptomonedas?")).toContain("No tengo confirmación");
    expect(buildPaymentPolicyReply("¿Aceptan Zelle?")).toContain("recargo del 10%");
  });

  it("calculates Zelle for a one-product catalogue list", () => {
    const reply = buildZelleTotalReply(
      "Estos son los productos ECOFLOW que aparecen en nuestro catálogo:\n• ECOFLOW DELTA 2 — 800 USD · Disponible",
      "Customer: ¿Cuánto es por Zelle?\nAgent: Aceptamos Zelle",
      true,
    );
    expect(reply).toContain("800 USD");
    expect(reply).toContain("880 USD");
  });

  it("refuses to calculate Zelle when a catalogue list contains multiple prices", () => {
    const reply = buildZelleTotalReply(
      "Catálogo:\n• ECOFLOW DELTA 2 — 800 USD\n• RIVER 2 PRO — 630 USD",
      "",
      true,
    );
    expect(reply).toBeNull();
  });
});
