import type { AgentConfig, AgentEnv, GuardrailResult, IntentLabel } from "./types";
import { buildClassifierPrompt } from "./system-prompt";
import { gatewayRunOptions } from "./gateway";

// Exact canned responses for refused intents. The CODING wording is a hard
// product requirement — the agent is a support assistant and must never
// soften into actually helping with code.
const CANNED: Record<Exclude<IntentLabel, "SUPPORT">, (biz: string) => string> = {
  CODING: () =>
    "Soy el asistente virtual de la tienda y solo puedo atender consultas sobre los productos de nuestro catálogo.",
  SENSITIVE: () =>
    "No estoy autorizado para compartir información interna o privada. Puedo ayudarte con consultas sobre nuestros productos en venta.",
  OFF_TOPIC: (biz) => `Soy el asistente virtual de ${biz} y solo estoy autorizado para responder consultas sobre los productos que comercializamos. ¿Qué producto de nuestro catálogo te interesa?`,
};

function toResult(label: IntentLabel, businessName: string): GuardrailResult {
  if (!isHardBlockedIntent(label)) return { allowed: true, label };
  return { allowed: false, label, cannedReply: CANNED[label as "CODING" | "SENSITIVE" | "OFF_TOPIC"](businessName) };
}

/** Keep safety boundaries, but do not hard-block ordinary conversational traffic. */
export function isHardBlockedIntent(label: IntentLabel | string): boolean {
  return label === "CODING" || label === "SENSITIVE" || label === "OFF_TOPIC";
}

/**
 * Fast, cheap gate that runs BEFORE any retrieval or generation. Uses a
 * small model so this costs a fraction of a full reply and keeps latency
 * low. Falls back to keyword rules if the model call fails, so a classifier
 * outage never opens the gate wide.
 */
export async function classifyIntent(
  env: AgentEnv,
  config: AgentConfig,
  message: string,
): Promise<GuardrailResult> {
  const keywordLabel = keywordPrecheck(message);
  if (keywordLabel) return toResult(keywordLabel, config.businessName);

  try {
    const result: any = await env.AI.run(
      config.models.classifier,
      {
        messages: [{ role: "user", content: buildClassifierPrompt(config, message) }],
        max_completion_tokens: 8,
        chat_template_kwargs: { enable_thinking: false },
      } as any,
      gatewayRunOptions(env, config.workspaceId, "classifier"),
    );
    const raw = String(result?.response ?? "").trim().toUpperCase();
    // Default open on an ambiguous parse — the RAG grounding + strict system
    // prompt are the real backstop for anything that slips past here.
    const label = (["SUPPORT", "CODING", "SENSITIVE", "OFF_TOPIC"] as IntentLabel[]).find((l) =>
      raw.startsWith(l),
    );
    return toResult(label ?? "SUPPORT", config.businessName);
  } catch {
    // Classifier down — fail closed rather than risk answering an unrelated
    // question or leaving the business-only scope. The customer can retry.
    return { allowed: false, label: "OFF_TOPIC", cannedReply: CANNED.OFF_TOPIC(config.businessName) };
  }
}

/**
 * Catches the obvious, cheap-to-detect cases without spending a model call.
 * Deliberately narrow patterns — a false positive here (e.g. matching
 * "write me an invoice" as CODING) would wrongly silence a real support
 * question, so the classifier handles everything that isn't unmistakable.
 */
export function keywordPrecheck(message: string): IntentLabel | null {
  const m = message.toLowerCase().trim();

  const coding =
    /\b(write|fix|debug|explain|review|refactor|deploy|create)\s*(me\s+|the\s+|this\s+)?(code|script|function|class|regex|sql|query|api|endpoint|dockerfile|config)\b/.test(m) ||
    /\b(code|script|debug|compile|syntax)\s*(me|this|for me)?\b/.test(m);
  if (coding) return "CODING";
  const sensitive =
    /\b(api\s*key|secret\s*key|auth\s*token|access\s*token|source\s*code|system\s*prompt|your\s*instructions|internal\s*(cost|price|pricing)|cost\s*price|profit\s*margin|margin\d*|another\s*customer('?s)?\s*(data|order|info)|username\s*and\s*password|credentials)\b/.test(
      m,
    );
  if (sensitive) return "SENSITIVE";
  return null;
}

/**
 * Deterministic replies for location questions. Run before RAG because private
 * residence and pickup details are intentionally absent from the public catalog.
 */
export function privateLocationReply(message: string): string | null {
  const m = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  if (/\b(tienda fisica|local fisico|establecimiento fisico|sucursal|showroom)\b/.test(m) ||
      (/\b(tienda|local|establecimiento)\b/.test(m) &&
       /\b(hay|tienen|tiene|donde|ubicacion|direccion|visitar|ir|abierta|abierto)\b/.test(m))) {
    return "No disponemos de una tienda física. Las consultas y ventas se realizan a través de los anuncios publicados en Revolico Sagua.";
  }
  if (/\b(recoger|recogida|retirar|retiro|pasar a buscar|punto de encuentro|entrega personal|donde recojo|donde busco)\b/.test(m)) {
    return "El asistente no dispone de un punto público de recogida. Cualquier coordinación debe acordarse directamente con el vendedor mediante el contacto publicado en el anuncio.";
  }
  if (/\b(donde vives|donde vive|donde viven|donde puedo encontrarte|donde puedo ubicarte|donde pueden ubicarme|donde te pueden ubicar|donde puedo localizarte|donde puedo encontrarte|donde puedo visitar(te)?|donde te encuentro|donde te ubico|donde se encuentra el dueno|donde esta el dueno|donde se encuentra el vendedor|direccion personal|direccion del dueno|direccion del vendedor|domicilio|residencia|casa del dueno|casa del vendedor|donde esta tu casa|donde queda tu casa|ubicacion personal|ubicacion del dueno|ubicacion del vendedor|localizar al dueno|donde estan ubicados|donde estan localizados)\b/.test(m) ||
      (/\b(donde|direccion|domicilio|ubicacion|residencia|casa)\b/.test(m) &&
       /\b(dueno|propietario|vendedor|vive|vives|viven|personal|ubicar|localizar|encontrar|visitar|encuentro|localizados|ubicados)\b/.test(m))) {
    return "No puedo proporcionar ni confirmar domicilios, residencia o ubicación privada del vendedor. Esa información no está disponible públicamente.";
  }
  return null;
}

/** Only escalate automatically when the customer asks for it or is clearly upset. */
export function shouldEscalateToHuman(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(human|person|agent|representative|team member|support staff)\b/.test(m) &&
    /\b(connect|speak|talk|transfer|escalat|real|please)\b/.test(m) ||
    /\b(frustrat|angry|furious|ridiculous|unacceptable|terrible|worst|useless|fed up)\b/.test(m);
}

// Regex net for anything the model might leak despite the system prompt.
// Runs on every final output before it's sent to a customer or cached.
const SENSITIVE_PATTERNS: RegExp[] = [
  /\b[sp]k_(live|test)?_?[A-Za-z0-9]{16,}\b/g, // Stripe-style API keys (live/test & raw)
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access keys
  /\b\d{13,19}\b/g, // card-number-length digit runs
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/g, // bearer tokens
  /\bgh[pous]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens/keys
  /\b(BEGIN|END)\s+(RSA|EC|OPENSSH|PRIVATE)\s+KEY\b/g, // key blocks
];

export function redactSensitive(text: string): string {
  const redacted = SENSITIVE_PATTERNS.reduce((t, re) => t.replace(re, "[redacted]"), text);
  // Enforce the store's official-site-only link rule at output time, not
  // only through prompting. Keep HTTPS links on the exact Revolico origin.
  return redacted.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
    const trailing = raw.match(/[),.!?;:]+$/)?.[0] ?? "";
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
    try {
      const url = new URL(candidate);
      return url.protocol === "https:" && url.origin === "https://revolico-sagua.pages.dev"
        ? raw
        : "[enlace externo omitido]" + trailing;
    } catch {
      return "[enlace no verificado]" + trailing;
    }
  });
}
