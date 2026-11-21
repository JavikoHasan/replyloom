import type { AgentEnv } from "./types";
import { ACTIVE_GENERATOR_MODEL } from "./config";

export const FALLBACK_GENERATOR: string = ACTIVE_GENERATOR_MODEL;

/**
 * Keep the existing call-site contract while using Workers AI directly.
 * Direct binding calls avoid an additional gateway dependency or billing
 * configuration; the Workers Free daily neuron allowance remains the cap.
 */
export function gatewayRunOptions(
  _env: AgentEnv,
  _workspaceId: string,
  _feature: string,
) {
  return {};
}
