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
  // Product-specific technical questions are commercial support, not requests for
  // private/internal data. Route them to catalog retrieval with focused search terms.
  if (config.businessName === "Cell Phone Store - Sagua la Grande" && isPhoneTechnicalSupportQuestion(message)) {
    const modelIds = [...message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().matchAll(/\b[a-z]{1,6}\s*\d{1,4}[a-z0-9]*\b/g)]
      .map((match) => match[0].replace(/\s+/g, ""))
      .filter((id) => !/^(?:4g|5g)$/.test(id));
    const modelHint = modelIds.length ? " modelo " + modelIds.join(" ") : "";
    return {
      allowed: true,
      label: "SUPPORT",
      searchQuery: "especificaciones tecnicas caracteristicas conectividad red 4G 5G memoria RAM ROM procesador pantalla bateria camara" + modelHint,
    };
  }
  // Known commercial phone-bundle questions must not be misclassified as OFF_TOPIC.
  if (config.businessName === "Cell Phone Store - Sagua la Grande" && isPhoneBundleSupportQuestion(message)) {
    return { allowed: true, label: "SUPPORT" };
  }
  const keywordLabel = keywordPrecheck(message);
  if (keywordLabel) return toResult(keywordLabel, config.businessName);

  try {
    const result: any = await env.AI.run(
      config.models.classifier,
      {
        messages: [{ role: "user", content: buildClassifierPrompt(config, message) }],
        max_completion_tokens: config.businessName === "Cell Phone Store - Sagua la Grande" ? 64 : 8,
        chat_template_kwargs: { enable_thinking: false },
      },
      gatewayRunOptions(env, config.workspaceId, "classifier"),
    );
    const raw = String(result?.response ?? result?.choices?.[0]?.message?.content ?? "").trim();
    // Default open on an ambiguous parse — the RAG grounding + strict system
    // prompt are the real backstop for anything that slips past here.
    const label = (["SUPPORT", "CODING", "SENSITIVE", "OFF_TOPIC"] as IntentLabel[]).find((l) =>
      new RegExp("^" + l + "\\b", "i").test(raw),
    );
    const base = toResult(label ?? "SUPPORT", config.businessName);
    const searchQuery = config.businessName === "Cell Phone Store - Sagua la Grande"
      ? raw.match(/^(?:SEARCH|BUSQUEDA|QUERY)\s*:\s*(.+)$/im)?.[1]?.trim().replace(/[\r\n]+/g, " ").slice(0, 180)
      : undefined;
    return { ...base, ...(base.allowed && searchQuery ? { searchQuery } : {}) };
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
/**
 * Store-only intent exception for questions about technical characteristics of
 * a specifically referenced phone. These are valid product questions, not
 * requests for private/internal information. The answer still requires sources.
 */
export function isPhoneTechnicalSupportQuestion(message: string): boolean {
  const m = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const asksTechnical =
    /\b(propiedades|caracteristicas|especificaciones|especificacion|4g|5g|conectividad|red movil|memoria|almacenamiento|ram|rom|procesador|pantalla|camara|bateria|carga|nfc|sistema operativo|resolucion|hz)\b/.test(m);
  const hasPhoneOrModel =
    /\b(samsung|galaxy|redmi|xiaomi|iphone|itel|tecno|infinix|motorola|honor|realme|oppo|vivo)\b/.test(m) ||
    /\b[a-z]{1,6}\s*\d{1,4}[a-z0-9]*\b/.test(m);
  return asksTechnical && hasPhoneOrModel;
}

/** Store-only intent exception for model-specific phone bundle/warranty questions. */
export function isPhoneBundleSupportQuestion(message: string): boolean {
  const m = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const asksBundle = /\b(incluye|incluyen|incluido|incluidos|trae|viene con|que trae|accesorios|garantia|dias de garantia)\b/.test(m);
  const namesPhone = /\b(samsung|galaxy|redmi|xiaomi|iphone|itel|tecno|infinix|motorola|honor|realme|oppo|vivo)\b/.test(m);
  const hasModelCode = /\b[a-z]{1,6}\d{1,4}[a-z0-9]*\b/.test(m);
  return asksBundle && (namesPhone || hasModelCode);
}

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
  // A customer's own address for a requested delivery is not the seller's location.
  const customerDeliveryAddress = /\b(mi direccion|mi domicilio|mi casa|a esta direccion|esta direccion)\b/.test(m)
    && /\b(traer|traiga|traigan|llevar|lleve|lleven|entrega|entregar|envio|enviar|mandar|pasar|pasas|pasarle|coordinar|disponible)\b/.test(m);
  if (customerDeliveryAddress) return null;

  // A request to physically visit or pick up may share the seller's address,
  // but the customer must coordinate with the seller before going there.
  const asksToVisitSeller = /\b(direccion|domicilio|ubicacion|donde|como llego|llegar|visitar|venir|ir|pasar|recoger|recogida|retirar|buscar)\b/.test(m)
    && /\b(venir|ir|pasar|visitar|llegar|recoger|recogida|retirar|buscar)\b/.test(m);
  if (asksToVisitSeller) {
    return "No tenemos tienda física. Si deseas pasar a recoger tu compra o visitarnos, nuestra dirección es: Edificio #5, Apartamento #1, Reparto 26 de Julio, Sagua la Grande, Villa Clara. Pregunta por Frank. Es importante que antes te pongas de acuerdo directamente con el vendedor para coordinar la visita o, si lo prefieres, organizar el domicilio del producto. Escríbele aquí: https://wa.me/5354590237.";
  }

  if (/\b(tienda fisica|local fisico|establecimiento fisico|sucursal|showroom)\b/.test(m) ||
      ( /\b(tienda|local|establecimiento|negocio|radican|radicados)\b/.test(m) &&
        /\b(hay|tienen|tiene|donde|ubicacion|direccion|visitar|ir|abierta|abierto|fisica|fisico)\b/.test(m))) {
    return "Radicamos en Sagua la Grande, Villa Clara. No tenemos tienda física; atendemos por WhatsApp y mediante nuestros anuncios publicados. Si deseas visitarnos o coordinar una compra, ponte de acuerdo primero con el vendedor: https://wa.me/5354590237.";
  }
  if (/\b(donde vives|donde vive|donde viven|direccion personal|direccion del dueno|direccion del vendedor|domicilio del dueno|domicilio del vendedor|residencia|casa del dueno|casa del vendedor|donde esta tu casa|donde queda tu casa|ubicacion personal|ubicacion del dueno|ubicacion del vendedor|localizar al dueno)\b/.test(m)) {
    return "Si deseas visitarnos para coordinar una compra, primero ponte de acuerdo directamente con el vendedor por WhatsApp: https://wa.me/5354590237.";
  }
  return null;
}

/** Escalate explicit human requests and clear frustration in English or Spanish. */
export function shouldEscalateToHuman(message: string): boolean {
  const m = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const asksHuman =
    (/\b(human|person|agent|representative|team member|support staff)\b/.test(m) &&
      /\b(connect|speak|talk|transfer|escalat|real|please|need|want)\b/.test(m)) ||
    /\b(quiero|quisiera|necesito|puedo|puede|podria|puedes|pasame|comunicame|conectame|transferirme|atenderme|hablar)\b.{0,45}\b(persona|alguien|humano|agente|representante|vendedor|asesor)\b/.test(m) ||
    /\b(hablar con|pasar con|comunicarme con|conectarme con|quiero al vendedor|necesito al vendedor)\b/.test(m);
  const frustrated =
    /\b(frustrat|angry|furious|ridiculous|unacceptable|terrible|worst|useless|fed up|frustrado|frustrada|molesto|molesta|enojado|enojada|furioso|furiosa|harto|harta|ridiculo|inaceptable|pesimo|pesima|inutil|decepcionado|decepcionada|estafado|estafada)\b/.test(m);
  return asksHuman || frustrated;
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

export function redactSensitive(text: string, storeAssistant = false): string {
  const redacted = SENSITIVE_PATTERNS.reduce((t, re) => t.replace(re, "[redacted]"), text);
  // Store-specific output safeguards must not alter other workspaces.
  let customerText = redacted;
  if (storeAssistant) {
    customerText = customerText
      .replace(/\(\s*no\s+convertir\s+monedas\s*\)/gi, "")
      .replace(/\bno\s+convertir\s+monedas\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(
        /\b(?:let me get|let me connect|i(?:'|’)ll get)\s+(?:a\s+)?(?:team member|human|representative|support agent)\s+to\s+help\s+with\s+that\.?/gi,
        "Para confirmar esa información, nuestro vendedor puede ayudarte directamente."
      );
  }
  // Enforce the store's official-site-only link rule at output time, not
  // only through prompting. Keep HTTPS links on the exact Revolico origin.
  return customerText.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
    const trailing = raw.match(/[),.!?;:]+$/)?.[0] ?? "";
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
    try {
      const url = new URL(candidate);
      return url.protocol === "https:" && (url.origin === "https://revolico-sagua.pages.dev" || (url.hostname === "wa.me" && url.pathname === "/5354590237"))
        ? raw
        : "[enlace externo omitido]" + trailing;
    } catch {
      return "[enlace no verificado]" + trailing;
    }
  });
}
