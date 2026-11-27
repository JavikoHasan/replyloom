import { describe, expect, it } from "vitest";
import { isPhoneTechnicalSupportQuestion } from "../guardrails";

describe("catalog-wide technical support intent", () => {
  it("allows product-specification questions for different product categories", () => {
    for (const question of [
      "Características del teléfono",
      "¿Qué potencia tiene la EcoFlow Delta 2?",
      "¿Qué cilindrada tiene la XMX 250cc?",
      "¿Qué consumo tiene el aire acondicionado?",
      "¿Qué dimensiones tiene la nevera?",
    ]) {
      expect(isPhoneTechnicalSupportQuestion(question), question).toBe(true);
    }
  });

  it("recognizes elliptical technical questions when recent conversation includes a product", () => {
    const messageWithThread = "[Previous messages]\nCustomer: Un A16\nAgent: Aparece en el catálogo\nCustomer: ¿Qué propiedades tiene?";
    expect(isPhoneTechnicalSupportQuestion(messageWithThread)).toBe(true);
  });

  it("does not treat unrelated technical chatter as a store product question", () => {
    expect(isPhoneTechnicalSupportQuestion("Explícame cómo funciona la gravedad")).toBe(false);
  });
});
