import { describe, expect, it } from "vitest";
import {
  buildShortCatalogProductSelectionReply,
  isShortCatalogProductSelection,
} from "../universal-catalog-intelligence";
import {
  addDeliverySchedulingCaveat,
  buildReservationPolicyReply,
  isDeliverySchedulingQuestion,
  resolveRecentProductQuery,
} from "../agent";
import { privateLocationReply } from "../guardrails";

const now = Date.parse("2026-11-27T12:00:00.000Z");
const sync = { stage: "completed", updatedAt: "2026-11-27T11:55:00.000Z" };
const catalog = [
  { text: "PRODUCTO: SAMSUNG GALAXY A17 — 4GB RAM / 128GB ROM\nCategoría: Telefonía\nPrecio publicado: 190 USD\nDisponibilidad publicada: Disponible" },
  { text: "PRODUCTO: SAMSUNG GALAXY A16 — 4GB RAM / 128GB ROM\nCategoría: Telefonía\nPrecio publicado: 170 USD\nDisponibilidad publicada: Disponible" },
];

describe("WhatsApp natural-language regression lab", () => {
  it("recognizes a model followed by a requested delivery date", () => {
    expect(isShortCatalogProductSelection("Quiero un A17 para mañana")).toBe(true);
    const reply = buildShortCatalogProductSelectionReply("Quiero un A17 para mañana", catalog, sync, now);
    expect(reply).toContain("SAMSUNG GALAXY A17");
    expect(reply).toContain("190 USD");
    expect(reply).not.toContain("SAMSUNG GALAXY A16");
  });

  it("does not substitute A17 when the customer explicitly asks for an unlisted A20", () => {
    const reply = buildShortCatalogProductSelectionReply("Me interesa un A20", catalog, sync, now);
    expect(reply).toContain("No encuentro");
    expect(reply).not.toContain("SAMSUNG GALAXY A17");
  });

  it("adds a clear no-booking caveat to a product selection with a delivery date", () => {
    const selection = "Sí, SAMSUNG GALAXY A17 aparece en nuestro catálogo. El precio publicado es 190 USD.";
    expect(isDeliverySchedulingQuestion("Quiero un A17 para mañana")).toBe(true);
    expect(addDeliverySchedulingCaveat("Quiero un A17 para mañana", selection)).toContain("No puedo confirmar ni programar una entrega");
  });

  it("does not add a scheduling caveat to a normal product question", () => {
    const selection = "Sí, SAMSUNG GALAXY A17 aparece en nuestro catálogo.";
    expect(addDeliverySchedulingCaveat("Me interesa un A17", selection)).toBe(selection);
  });

  it("treats a bare address request as a location question, not a delivery question", () => {
    const reply = privateLocationReply("Dirección");
    expect(reply).toContain("No tenemos tienda física");
    expect(reply).not.toContain("Entrega a domicilio gratuita");
    expect(reply).not.toContain("Edificio #5");
  });

  it("answers where the business is based without exposing a private pickup address", () => {
    const reply = privateLocationReply("¿Dónde radican?");
    expect(reply).toContain("Sagua la Grande");
    expect(reply).not.toContain("Edificio #5");
  });

  it("recognizes an order/encargo request as a handoff, not an order confirmation", () => {
    const reply = buildReservationPolicyReply("¿Puedo encargar contigo?", "SAMSUNG GALAXY A17");
    expect(reply).toContain("No puedo formalizar ni garantizar reservas");
    expect(reply).toContain("WhatsApp");
  });

  it("keeps a newly named model instead of reviving the older product from chat history", () => {
    const thread = "Customer: Un A17\nAgent: El A17 aparece en catálogo";
    expect(resolveRecentProductQuery("Me interesa un A20", thread)).toBe("Me interesa un A20");
  });
});
