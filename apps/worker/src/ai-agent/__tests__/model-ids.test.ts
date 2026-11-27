import { describe, expect, it } from "vitest";
import { normalizeModelId, ACTIVE_CLASSIFIER_MODEL } from "../config";

describe("normalizeModelId", () => {
  it("maps deprecated Llama 3.1 model ids to the active support-agent model", () => {
    expect(normalizeModelId("@cf/meta/infire-llama-3.1-8b-instruct")).toBe(
      "@cf/google/gemma-4-26b-a4b-it"
    );
    expect(normalizeModelId("@cf/meta/llama-3.1-8b-instruct")).toBe(
      "@cf/google/gemma-4-26b-a4b-it"
    );
  });

  it("maps the legacy small Llama classifier to the active classifier model", () => {
    expect(normalizeModelId("@cf/meta/llama-3.2-3b-instruct")).toBe(
      ACTIVE_CLASSIFIER_MODEL
    );
  });
});
