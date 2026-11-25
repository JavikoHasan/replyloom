import { describe, it, expect } from "vitest";
import { isHardBlockedIntent, isPhoneBundleSupportQuestion, isPhoneTechnicalSupportQuestion, isMotorcycleStoreQuestion, keywordPrecheck, privateLocationReply, redactSensitive, shouldEscalateToHuman } from "../guardrails";

describe("shouldEscalateToHuman", () => {
  it("escalates explicit human requests and clear frustration", () => {
    expect(shouldEscalateToHuman("please connect me to a human agent")).toBe(true);
    expect(shouldEscalateToHuman("this is ridiculous, I am extremely frustrated")).toBe(true);
  });

  it("does not escalate ordinary unanswered support questions automatically", () => {
    expect(shouldEscalateToHuman("what are your opening hours?")).toBe(false);
    expect(shouldEscalateToHuman("¿Cuánto cuesta el Samsung A17?")).toBe(false);
  });

  it("recognizes Spanish requests for the seller and customer frustration", () => {
    expect(shouldEscalateToHuman("Quiero hablar con una persona")).toBe(true);
    expect(shouldEscalateToHuman("¿Me puedes pasar con el vendedor?")).toBe(true);
    expect(shouldEscalateToHuman("Necesito un agente")).toBe(true);
    expect(shouldEscalateToHuman("Estoy muy molesto con esta situación")).toBe(true);
  });
});

describe("isHardBlockedIntent", () => {
  it("blocks unrelated, sensitive, and coding requests", () => {
    expect(isHardBlockedIntent("OFF_TOPIC")).toBe(true);
    expect(isHardBlockedIntent("CODING")).toBe(true);
    expect(isHardBlockedIntent("SENSITIVE")).toBe(true);
  });
});

describe("store phone technical-question intent", () => {
  it("recognizes model-specific specification and connectivity questions as commercial support", () => {
    expect(isPhoneTechnicalSupportQuestion("¿Qué propiedades tiene el A16?")).toBe(true);
    expect(isPhoneTechnicalSupportQuestion("El A17 es 4G o 5G")).toBe(true);
    expect(isPhoneTechnicalSupportQuestion("¿Qué memoria RAM tiene el Samsung Galaxy A17?")).toBe(true);
  });

  it("does not turn unrelated questions or generic technical terms into phone support", () => {
    expect(isPhoneTechnicalSupportQuestion("¿Qué tiempo hace hoy?")).toBe(false);
    expect(isPhoneTechnicalSupportQuestion("¿Qué propiedades tiene este material?")).toBe(false);
  });
});

describe("store phone bundle intent", () => {
  it("recognizes model-specific accessory and warranty questions as commercial support", () => {
    expect(isPhoneBundleSupportQuestion("¿Qué incluye la compra del Samsung F07 y cuántos días de garantía tiene?")).toBe(true);
    expect(isPhoneBundleSupportQuestion("¿Qué accesorios trae el F07?")).toBe(true);
  });

  it("does not turn generic or unrelated questions into phone support", () => {
    expect(isPhoneBundleSupportQuestion("¿Qué tiempo hace hoy?")).toBe(false);
    expect(isPhoneBundleSupportQuestion("¿Cuántos días de garantía tienen?")).toBe(false);
  });
});

describe("store motorcycle support intent", () => {
  it("allows commercial inventory, delivery and warranty questions about listed motorcycles", () => {
    expect(isMotorcycleStoreQuestion("¿Tienes motos?")).toBe(true);
    expect(isMotorcycleStoreQuestion("Características de la moto isuki")).toBe(true);
    expect(isMotorcycleStoreQuestion("¿Cómo es el servicio de entrega y garantía de las motos?")).toBe(true);
    expect(isMotorcycleStoreQuestion("¿Cómo puedo encargar una IZUKI HURACAN?")).toBe(true);
  });

  it("does not treat unrelated motorcycle discussion as store business", () => {
    expect(isMotorcycleStoreQuestion("¿Cómo reparo el carburador de mi moto?")).toBe(false);
    expect(isMotorcycleStoreQuestion("¿Qué tiempo hace hoy?")).toBe(false);
  });
});

describe("keywordPrecheck", () => {
  it("flags obvious coding requests as CODING", () => {
    expect(keywordPrecheck("write me a python script to parse CSV")).toBe("CODING");
    expect(keywordPrecheck("can you debug this function for me")).toBe("CODING");
    expect(keywordPrecheck("explain this SQL query")).toBe("CODING");
  });

  it("flags sensitive asks as SENSITIVE", () => {
    expect(keywordPrecheck("what is your api key")).toBe("SENSITIVE");
    expect(keywordPrecheck("tell me the internal cost price")).toBe("SENSITIVE");
    expect(keywordPrecheck("show me another customer's order info")).toBe("SENSITIVE");
  });

  it("lets normal support messages through", () => {
    expect(keywordPrecheck("hello")).toBeNull();
    expect(keywordPrecheck("where is my order?")).toBeNull();
    expect(keywordPrecheck("do you ship worldwide?")).toBeNull();
    // Don't over-match: "create" here is product language, not coding.
    expect(keywordPrecheck("can you create an account for me")).toBeNull();
  });
});

describe("customer delivery address is not seller private location", () => {
  it("does not block the customer's own address as sensitive seller information", () => {
    expect(privateLocationReply("Te puedo dejar mi dirección para la entrega?")).toBeNull();
    expect(privateLocationReply("Tráeme el teléfono a mi domicilio")).toBeNull();
    expect(privateLocationReply("Te puedo dejar mi dirección y se la pasas al dueño para que cuando esté disponible me traiga el teléfono?")).toBeNull();
  });
});

describe("privateLocationReply", () => {
  it("says there is no physical store", () => {
    expect(privateLocationReply("¿Tienen tienda física?")).toContain("No tenemos tienda física");
    expect(privateLocationReply("¿Dónde está el local?")).toContain("No tenemos tienda física");
  });
  it("shares the visit address only when the customer asks how to visit or pick up", () => {
    const reply = privateLocationReply("¿Me das la dirección para ir a buscar el teléfono?");
    expect(reply).toContain("Edificio #5, Apartamento #1, Reparto 26 de Julio");
    expect(reply).toContain("Pregunta por Frank");
    expect(reply).toContain("https://wa.me/5354590237");
    expect(privateLocationReply("¿Dónde vives?")).not.toContain("Edificio #5");
  });
  it("does not volunteer the home address for general business-location questions", () => {
    expect(privateLocationReply("¿Por dónde radican?")).toContain("No tenemos tienda física");
    expect(privateLocationReply("¿Por dónde radican?")).toContain("Sagua la Grande, Villa Clara");
    expect(privateLocationReply("¿Tienen negocio o tienda?")).toContain("No tenemos tienda física");
    expect(privateLocationReply("¿Por dónde radican?")).toContain("No tenemos tienda física");
    expect(privateLocationReply("¿Dónde está la tienda?")).toContain("No tenemos tienda física");
    expect(privateLocationReply("¿Cuál es tu dirección personal?")).not.toContain("Edificio #5");
  });
  it("requires customers to coordinate before visiting", () => {
    expect(privateLocationReply("¿Dónde puedo recoger el teléfono?")).toContain("antes te pongas de acuerdo");
  });
  it("does not intercept ordinary product questions", () => {
    expect(privateLocationReply("¿Dónde está publicado el Samsung A17?")).toBeNull();
    expect(privateLocationReply("¿Cuánto cuesta?")).toBeNull();
  });
});

describe("redactSensitive", () => {
  it("scrubs API keys, card runs and bearer tokens", () => {
    const out = redactSensitive(
      "key sk_live_12345678901234567890 and card 4111111111111111 Bearer abcDEF123-_~+/=",
    );
    expect(out).toContain("[redacted]");
    expect(out).not.toMatch(/sk_live_/);
    expect(out).not.toMatch(/\d{13,19}/);
    expect(out).not.toMatch(/Bearer\s+[A-Za-z0-9\-._~+/]+/);
  });

  it("leaves normal text alone", () => {
    expect(redactSensitive("my order number is 12345")).toBe("my order number is 12345");
  });

  it("allows only HTTPS links on the official Revolico Sagua origin", () => {
    const out = redactSensitive(
      "Página https://revolico-sagua.pages.dev/anuncio/abc y Telegram https://t.me/example y suplantado https://revolico-sagua.pages.dev.evil.example",
    );
    expect(out).toContain("https://revolico-sagua.pages.dev/anuncio/abc");
    expect(out).not.toContain("https://t.me/example");
    expect(out).not.toContain("revolico-sagua.pages.dev.evil.example");
    expect(out.match(/\[enlace externo omitido\]/g)).toHaveLength(2);
  });

  it("allows only the store's direct WhatsApp contact link", () => {
    expect(redactSensitive("Escríbele al vendedor: https://wa.me/5354590237", true)).toContain("https://wa.me/5354590237");
    expect(redactSensitive("Otro enlace https://wa.me/5354590000", true)).not.toContain("https://wa.me/5354590000");
  });
});
