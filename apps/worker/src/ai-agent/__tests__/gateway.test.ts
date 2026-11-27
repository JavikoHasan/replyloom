import { describe, it, expect } from "vitest";
import { gatewayRunOptions, FALLBACK_GENERATOR } from "../gateway";
import { ACTIVE_GENERATOR_MODEL } from "../config";
import type { AgentEnv } from "../types";

function env(): AgentEnv {
  return {} as AgentEnv;
}

describe("gatewayRunOptions", () => {
  it("does not configure a paid AI Gateway dependency on the free profile", () => {
    expect(gatewayRunOptions(env(), "ws_1", "generator")).toEqual({});
  });
});

describe("FALLBACK_GENERATOR", () => {
  it("uses the active Workers AI generator model", () => {
    expect(FALLBACK_GENERATOR).toBe(ACTIVE_GENERATOR_MODEL);
  });
});
