import { describe, expect, it } from "vitest";
import {
  ACTIVE_CLASSIFIER_MODEL,
  ACTIVE_GENERATOR_MODEL,
  normalizeModelId,
} from "../config";

describe("Workers AI model migration", () => {
  it("uses a currently available classifier for deprecated Llama 3.2 models", () => {
    expect(normalizeModelId("@cf/meta/llama-3.2-1b-instruct")).toBe(ACTIVE_CLASSIFIER_MODEL);
    expect(normalizeModelId("@cf/meta/llama-3.2-3b-instruct")).toBe(ACTIVE_CLASSIFIER_MODEL);
    expect(ACTIVE_CLASSIFIER_MODEL).toBe("@cf/zai-org/glm-4.7-flash");
  });

  it("maps legacy Llama 3.1 generator settings to the current generator", () => {
    expect(normalizeModelId("@cf/meta/llama-3.1-8b-instruct")).toBe(ACTIVE_GENERATOR_MODEL);
    expect(normalizeModelId("@cf/meta/infire-llama-3.1-8b-instruct")).toBe(ACTIVE_GENERATOR_MODEL);
  });

  it("leaves current model ids unchanged", () => {
    expect(normalizeModelId(ACTIVE_CLASSIFIER_MODEL)).toBe(ACTIVE_CLASSIFIER_MODEL);
    expect(normalizeModelId(ACTIVE_GENERATOR_MODEL)).toBe(ACTIVE_GENERATOR_MODEL);
  });
});
