import type { AgentConfig, AgentContext, AgentEnv, AgentInput, AgentReply, RetrievedChunk, ToolSchema } from "./types";
import { classifyIntent, privateLocationReply, redactSensitive, shouldEscalateToHuman } from "./guardrails";
import { createDb, eq, desc, messages } from "@workspace/db";
import { retrieveContext, retrieveCatalogChunks } from "./rag";
import { buildSystemPrompt } from "./system-prompt";
import { STORE_POLICY } from "./store-policy";
import { cachePrefixes } from "./config";
import { gatewayRunOptions, FALLBACK_GENERATOR } from "./gateway";
import { executeTool, buildDefaultRegistry, listWorkspaceWebhookTools, workspaceToolToSchema } from "./tools";
import { customerPhoneFromJid } from "./util";

const registry = buildDefaultRegistry();
const MAX_TURNS = 2; // generation loop depth, not conversation turns
const MAX_REPLY_TOKENS = 400;
const MAX_INPUT_CHARS = 4000;
const MAX_THREAD_CHARS = 1500;
const THREAD_MESSAGE_LIMIT = 12;

const NO_INFO_REPLY =
  "Soy el asistente virtual de Cell Phone Store. Solo estoy autorizado para informar sobre los productos publicados y datos que estén verificados. No tengo información confirmada sobre esa consulta; para evitar errores, puedes consultarlo directamente con el vendedor.";
const CLARIFY_REPLY =
  "¡Hola! 👋 Soy el asistente virtual de Cell Phone Store - Sagua la Grande. Estoy aquí para atenderte cuando el vendedor no esté disponible y ayudarte con información sobre nuestros productos, precios publicados, formas de pago y condiciones de entrega. Si deseas hablar directamente con el vendedor o confirmar una compra, puedes escribirle por WhatsApp aquí: https://wa.me/5354590237. ¡Con gusto te ayudo!";

/**
 * The full agent pipeline for one inbound customer message:
 *
 *   1. Exact-match KV cache  — repeat FAQs answered for ~0 tokens.
 *   2. Intent gate           — cheap classifier blocks CODING / SENSITIVE /
 *                              OFF_TOPIC before any retrieval/generation spend.
 *   3. RAG retrieval         — only chunks above the similarity threshold are
 *                              trusted as grounding (anti-hallucination lever #1).
 *   4. Generation            — tools allowed; a strict system prompt says facts
 *                              must come from context or tool results.
 *   5. Tool-gate             — with zero grounding, a reply is only kept if a
 *                              tool actually answered it; otherwise hand off to a
 *                              human instead of letting the model free-wheel.
 *   6. Redaction + cache     — sensitive patterns scrubbed; tool-free grounded
 *                              answers cached (cheap repeats), tool answers never.
 *
 * Returns a blocked/grounded/cached result — callers (WhatsApp auto-reply,
 * HTTP integrations) just send `reply.text` if present.
 */
export async function handleAgentMessage(
  env: AgentEnv,
  config: AgentConfig,
  input: AgentInput,
): Promise<AgentReply> {
  if (!config.enabled) return { text: "", usedTools: [], usedContext: [], blocked: true, blockReason: "OFF_TOPIC", cached: false };

  const message = input.message.trim().slice(0, MAX_INPUT_CHARS);
  if (!message) return { text: "", usedTools: [], usedContext: [], blocked: false, cached: false };

  const catalogOnlyBusiness = config.businessName === "Cell Phone Store - Sagua la Grande";
  if (catalogOnlyBusiness) {
    const locationReply = privateLocationReply(message);
    if (locationReply) {
      return { text: locationReply, usedTools: [], usedContext: [], blocked: true, blockReason: "SENSITIVE", cached: false };
    }
  }
  // The store's catalog and policy answers are cheap to retrieve from D1.
  // Do not persist every unique customer message in KV: that turns ordinary
  // WhatsApp traffic into a paid write operation. Other workspaces keep cache.
  const replyCacheTtlSeconds = catalogOnlyBusiness ? 0 : config.cacheTtlSeconds;

  const customerPhone =
    input.customerPhone ??
    customerPhoneFromJid(input.isGroup ? input.senderJid : input.remoteJid) ??
    undefined;
  const ctx: AgentContext = {
    env,
    config,
    workspaceId: config.workspaceId,
    conversationId: input.conversationId,
    waSessionId: input.waSessionId,
    remoteJid: input.remoteJid,
    senderJid: input.senderJid,
    customerPhone,
    isGroup: input.isGroup ?? false,
  };

  // Record a human handoff before retrieval/generation, even when the catalog
  // contains a matching product. The seller must be able to take over a chat
  // whenever a customer explicitly asks for a person or is clearly upset.
  if (catalogOnlyBusiness && shouldEscalateToHuman(message)) {
    const result = await registry.run(
      "escalate_to_human",
      { reason: `Customer requested the seller or expressed frustration: ${message}` },
      ctx,
    );
    if (result.startsWith("Escalated to a human agent")) {
      return {
        text: "He registrado tu solicitud para que el vendedor pueda revisarla cuando esté disponible.",
        usedTools: ["escalate_to_human"],
        usedContext: [],
        blocked: false,
        cached: false,
      };
    }
    return { text: NO_INFO_REPLY, usedTools: [], usedContext: [], blocked: false, cached: false };
  }

  // ── 1) Cheap exact-match cache — zero model spend on repeat FAQs ──
  const cacheKey = `${cachePrefixes.replies}${config.workspaceId}:${catalogOnlyBusiness ? "catalog-v3:" : ""}${normalize(message)}`;
  if (replyCacheTtlSeconds > 0) {
    const cached = await env.REPLY_CACHE.get(cacheKey);
    if (cached) {
      return { text: cached, usedTools: [], usedContext: [], blocked: false, cached: true };
    }
  }

  // Store greetings must not depend on the classifier or catalog retrieval.
  // This guarantees a harmless first "hola" receives a useful Spanish response.
  if (catalogOnlyBusiness && isSimpleGreeting(message)) {
    return { text: CLARIFY_REPLY, usedTools: [], usedContext: [], blocked: false, cached: false };
  }

  // Keep a larger, bounded recent thread for multi-turn product/payment/delivery
  // follow-ups. The previous four-message window lost the original Zelle exchange
  // after a customer asked a clarification and repeated the model name.
  const recentThread = catalogOnlyBusiness
    ? await loadConversationThread(env, input, THREAD_MESSAGE_LIMIT)
    : "";
  const contextualProductQuery = catalogOnlyBusiness
    ? resolveRecentProductQuery(message, recentThread)
    : message;
  const asksZelleNow = /\bzelle\b/i.test(normalizeBusinessText(message));

  // Delivery questions are answered from the delivery field of the exact live
  // listing. Category defaults are never used to override a listing's explicit
  // delivery option.
  if (catalogOnlyBusiness && isDeliveryQuestion(message)) {
    try {
      const syncStatus = await env.REPLY_CACHE
        .get<{ stage?: string; updatedAt?: string }>("revolico:catalog-sync:status", "json")
        .catch(() => null);
      const allCatalogChunks = await retrieveCatalogChunks(env, config, "revolico-sagua.pages.dev");
      const deliveryReply = buildCatalogDeliveryReply(contextualProductQuery, allCatalogChunks, syncStatus)
        ?? buildGeneralDeliveryPolicyReply(message);
      if (deliveryReply) {
        console.info("[catalog-agent] deterministic-delivery-policy", { responsePresent: true, contextRows: allCatalogChunks.length });
        return { text: deliveryReply, usedTools: [], usedContext: allCatalogChunks, blocked: false, cached: false };
      }
    } catch (error) {
      console.warn("[catalog-agent] deterministic-delivery-error", { errorType: error instanceof Error ? error.name : typeof error });
      return { text: NO_INFO_REPLY, usedTools: [], usedContext: [], blocked: false, cached: false };
    }
  }

  // If Zelle is mentioned together with a product, or the product is clear
  // from the recent thread, resolve its exact current listing and calculate
  // the total before returning the generic payment-policy explanation.
  if (catalogOnlyBusiness && asksZelleNow && hasProductReference(contextualProductQuery)) {
    try {
      const syncStatus = await env.REPLY_CACHE
        .get<{ stage?: string; updatedAt?: string }>("revolico:catalog-sync:status", "json")
        .catch(() => null);
      const allCatalogChunks = await retrieveCatalogChunks(env, config, "revolico-sagua.pages.dev");
      const catalogReply = buildCatalogLookupReply(contextualProductQuery, allCatalogChunks, syncStatus);
      if (catalogReply) {
        const zelleReply = buildZelleTotalReply(catalogReply, recentThread + "\nCustomer: " + message, true);
        if (zelleReply) {
          console.info("[catalog-agent] deterministic-zelle-product-total", { responsePresent: true });
          return { text: zelleReply, usedTools: [], usedContext: allCatalogChunks, blocked: false, cached: false };
        }
      }
    } catch (error) {
      console.warn("[catalog-agent] deterministic-zelle-total-error", { errorType: error instanceof Error ? error.name : typeof error });
    }
  }

  // Payment policy is resolved only after product-aware follow-ups. CUP is
  // never converted and Zelle totals are calculated from the live listing.
  if (catalogOnlyBusiness) {
    const paymentReply = buildPaymentPolicyReply(message);
    if (paymentReply) {
      console.info("[catalog-agent] deterministic-payment-policy", { matched: true });
      return { text: paymentReply, usedTools: [], usedContext: [], blocked: false, cached: false };
    }
  }

  // Inventory and exact-model lookups remain deterministic and catalog-grounded.
  if (catalogOnlyBusiness && isCatalogLookupQuestion(message)) {
    try {
      const syncStatus = await env.REPLY_CACHE
        .get<{ stage?: string; updatedAt?: string }>("revolico:catalog-sync:status", "json")
        .catch(() => null);
      const allCatalogChunks = await retrieveCatalogChunks(env, config, "revolico-sagua.pages.dev");
      const catalogLookupReply = buildCatalogLookupReply(contextualProductQuery, allCatalogChunks, syncStatus);
      const zelleAwareReply = catalogLookupReply
        ? buildZelleTotalReply(catalogLookupReply, recentThread)
          ?? (asksZelleNow ? buildZelleTotalReply(catalogLookupReply, recentThread, true) : null)
          ?? catalogLookupReply
        : null;
      console.info("[catalog-agent] deterministic-catalog-lookup", {
        queryType: "inventory-or-model",
        contextRows: allCatalogChunks.length,
        syncStage: syncStatus?.stage ?? "missing",
        responsePresent: Boolean(zelleAwareReply),
        responseLength: zelleAwareReply?.length ?? 0,
        zelleFollowUp: zelleAwareReply !== catalogLookupReply,
      });
      return {
        text: zelleAwareReply ?? NO_INFO_REPLY,
        usedTools: [],
        usedContext: allCatalogChunks,
        blocked: false,
        cached: false,
      };
    } catch (error) {
      console.warn("[catalog-agent] deterministic-catalog-lookup-error", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return { text: NO_INFO_REPLY, usedTools: [], usedContext: [], blocked: false, cached: false };
    }
  }

  // ── 1b) Conversation thread — gives the model continuity for follow-ups
  // like "and shipping?" without a full message-history tool call, and
  // grounds the RAG query in what the customer was actually asking about. ──
  const currentMessageHasModel = /\b(?:[a-z]{1,8}\s*\d{1,4}[a-z0-9]*|\d{1,3}[a-z]{1,4})\b/i.test(message)
    && !/\b\d+(?:gb|mb|ram|rom)\b/i.test(message);
  const thread = input.conversationId && (!catalogOnlyBusiness || !currentMessageHasModel)
    ? await loadConversationThread(env, input, THREAD_MESSAGE_LIMIT)
    : "";
  const query = thread ? `${thread}\n\n${message}` : message;
  // This store is a product-information-only assistant: do not expose CRM
  // customer/order tools or arbitrary workspace webhooks to its model.
  const [gate, workspaceTools, lexicalContext] = await Promise.all([
    classifyIntent(env, config, catalogOnlyBusiness ? query : message),
    catalogOnlyBusiness ? Promise.resolve([]) : listWorkspaceWebhookTools(env, config.workspaceId),
    retrieveContext(env, config, query, catalogOnlyBusiness ? "revolico-sagua.pages.dev" : undefined, catalogOnlyBusiness ? ["condiciones-venta-telefonos"] : []),
  ]);
  let context = lexicalContext;

  // Semantic query hints are generated by the existing small intent model.
  // They improve retrieval for paraphrases without authoring answers or facts.
  // The hint is placed first so the lexical retriever sees intent terms within its token budget.
  if (catalogOnlyBusiness && gate.allowed && gate.searchQuery) {
    try {
      const semanticContext = await retrieveContext(
        env,
        config,
        `${gate.searchQuery}\n${query}`,
        "revolico-sagua.pages.dev",
        ["condiciones-venta-telefonos"],
      );
      const unique = new Map<string, RetrievedChunk>();
      for (const chunk of [...context, ...semanticContext]) unique.set(chunk.id, chunk);
      context = [...unique.values()].slice(0, 8);
      console.info("[catalog-agent] semantic-retrieval", {
        searchHintPresent: true,
        lexicalRows: lexicalContext.length,
        semanticRows: semanticContext.length,
        mergedRows: context.length,
      });
    } catch (error) {
      console.warn("[catalog-agent] semantic-retrieval-error", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  if (catalogOnlyBusiness) {
    console.info("[catalog-agent] pipeline-input", {
      gateAllowed: gate.allowed,
      gateLabel: gate.label,
      contextRows: context.length,
      semanticQueryUsed: Boolean(gate.searchQuery),
      hasThread: Boolean(thread),
    });
  }

  if (!gate.allowed) {
    const text = gate.cannedReply!;
    if (replyCacheTtlSeconds > 0) await cache(env, config, cacheKey, text, replyCacheTtlSeconds);
    return { text, usedTools: [], usedContext: [], blocked: true, blockReason: gate.label, cached: false };
  }

  // For the store's public catalog, answer exact price questions deterministically
  // from a fresh completed Revolico sync. This avoids a language model turning a
  // clearly grounded price into a generic human handoff or inventing a value.
  if (catalogOnlyBusiness && context.length > 0) {
    const syncStatus = await env.REPLY_CACHE
      .get<{ stage?: string; updatedAt?: string }>("revolico:catalog-sync:status", "json")
      .catch(() => null);
    const catalogReply = buildCatalogPriceReply(message, context, syncStatus);
    if (catalogReply) {
      return {
        text: catalogReply,
        usedTools: [],
        usedContext: context,
        blocked: false,
        cached: false,
      };
    }
  }


  // Answer the store's fixed phone bundle directly from the permanent code policy.
  // This avoids dependence on a policy chunk being selected by RAG.
  if (catalogOnlyBusiness) {
    const phoneBundleReply = buildPhoneBundleReply(message, context);
    if (phoneBundleReply) {
      return {
        text: phoneBundleReply,
        usedTools: [],
        usedContext: context,
        blocked: false,
        cached: false,
      };
    }
  }

  // Permanent category policies can answer policy questions even when RAG
  // has no matching listing. The reply must never imply that a model is
  // currently advertised or in stock; catalog presence remains a separate check.
  if (catalogOnlyBusiness) {
    const policyReply = buildStorePolicyOnlyReply(message);
    if (policyReply) {
      return {
        text: policyReply,
        usedTools: [],
        usedContext: context,
        blocked: false,
        cached: false,
      };
    }
  }

  // The store assistant has no CRM or external-search tools. If the public
  // catalog contains no matching facts, return a fixed safe answer without
  // spending a second Workers AI generation call.
  if (catalogOnlyBusiness && context.length === 0) {
    return {
      text: isSimpleGreeting(message) ? CLARIFY_REPLY : NO_INFO_REPLY,
      usedTools: [],
      usedContext: [],
      blocked: false,
      cached: false,
    };
  }

  // ── Tool list (built-ins + workspace webhooks) built once per message ──
  const toolSchemas: ToolSchema[] = catalogOnlyBusiness
    ? []
    : [...registry.toToolSchemas(), ...workspaceTools.map(workspaceToolToSchema)];

  // ── No grounding: the tool-only branch. A reply survives only if the
  //    model actually used a tool (order lookup, profile, ...) — otherwise
  //    the model's own knowledge is not allowed to answer, and we hand off.
  if (context.length === 0) {
    const { text, usedTools } = await generateReply(ctx, message, [], toolSchemas, thread);
    if (usedTools.length === 0 || !text) {
      if (isSimpleGreeting(message)) {
        return { text: CLARIFY_REPLY, usedTools, usedContext: [], blocked: false, cached: false };
      }
      if (shouldEscalateToHuman(message)) {
        await registry.run("escalate_to_human", { reason: `Customer requested help from a human or expressed frustration: ${message}` }, ctx);
        return { text: NO_INFO_REPLY, usedTools: ["escalate_to_human"], usedContext: [], blocked: false, cached: false };
      }
      return { text: NO_INFO_REPLY, usedTools, usedContext: [], blocked: false, cached: false };
    }
    return { text: redactSensitive(text, catalogOnlyBusiness), usedTools, usedContext: [], blocked: false, cached: false };
  }

  // ── 4+5) Grounded generation (context + tools, at most 2 tool turns) ──
  const { text, usedTools } = await generateReply(ctx, message, context, toolSchemas, thread);
  if (catalogOnlyBusiness) {
    console.info("[catalog-agent] generation-result", {
      contextRows: context.length,
      responseLength: text.length,
      usedToolCount: usedTools.length,
      responsePresent: Boolean(text),
    });
  }
  const safeText = redactSensitive(text || (catalogOnlyBusiness ? NO_INFO_REPLY : "I will connect you with a team member for help."), catalogOnlyBusiness);

  // ── 6) Cache tool-free grounded answers only — per-customer tool results
  //    (order status, balance, ...) are never cached. ──
  if (usedTools.length === 0 && replyCacheTtlSeconds > 0) {
    await cache(env, config, cacheKey, safeText, replyCacheTtlSeconds);
  }

  return { text: safeText, usedTools, usedContext: context, blocked: false, cached: false };
}

async function generateReply(
  ctx: AgentContext,
  message: string,
  context: RetrievedChunk[],
  toolSchemas: ToolSchema[],
  thread = "",
): Promise<{ text: string; usedTools: string[] }> {
  const systemPrompt = buildSystemPrompt(ctx.config, context, context.length > 0);
  const userContent = thread ? `${thread}\n\n${message}` : message;
  const chatMessages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  const usedTools: string[] = [];
  let finalText = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const body = {
      messages: chatMessages,
      tools: toolSchemas,
      max_tokens: MAX_REPLY_TOKENS,
    };
    const runOptions = gatewayRunOptions(ctx.env, ctx.workspaceId, "generator");

    let result: any;
    try {
      result = await ctx.env.AI.run(ctx.config.models.generator, body, runOptions);
      if (ctx.config.businessName === "Cell Phone Store - Sagua la Grande") {
        const normalized = normalizeGeneratorResult(result);
        console.info("[catalog-agent] generator-response", {
          turn,
          responsePresent: Boolean(normalized.response),
          responseLength: normalized.response.length,
          toolCallCount: normalized.toolCalls.length,
          resultType: typeof result,
          responseFormat: normalized.format,
        });
      }
    } catch (error) {
      // Primary model failed (after the gateway's own retries) — fail down to
      // a lighter model rather than letting the reply die for the customer.
      if (ctx.config.businessName === "Cell Phone Store - Sagua la Grande") {
        console.warn("[catalog-agent] generator-primary-error", {
          turn,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
      result = await ctx.env.AI.run(FALLBACK_GENERATOR, body, runOptions);
      if (ctx.config.businessName === "Cell Phone Store - Sagua la Grande") {
        const normalized = normalizeGeneratorResult(result);
        console.info("[catalog-agent] generator-fallback-response", {
          turn,
          responsePresent: Boolean(normalized.response),
          responseLength: normalized.response.length,
          toolCallCount: normalized.toolCalls.length,
          resultType: typeof result,
          responseFormat: normalized.format,
        });
      }
    }

    const normalized = normalizeGeneratorResult(result);
    if (normalized.toolCalls.length === 0) {
      finalText = normalized.response;
      break;
    }

    for (const call of normalized.toolCalls) {
      const name = call.name;
      if (!name) continue;
      const args = parseToolArgs(call.arguments);
      const output = await executeTool(ctx.env, ctx.workspaceId, name, args, ctx, registry);
      usedTools.push(name);
      if (normalized.format === "openai") {
        chatMessages.push({
          role: "assistant",
          content: null,
          tool_calls: [call.raw],
        });
        chatMessages.push({
          role: "tool",
          tool_call_id: call.raw?.id,
          content: output,
        });
      } else {
        chatMessages.push({ role: "assistant", content: null, tool_calls: [call.raw] });
        chatMessages.push({ role: "tool", name, content: output });
      }
    }
  }

  return { text: finalText, usedTools };
}

/**
 * Normalize the legacy Workers AI response and the OpenAI-compatible
 * chat-completion response returned by newer models such as Gemma 4.
 * Tool-call envelopes are preserved so follow-up turns retain their native format.
 */
export function normalizeGeneratorResult(result: any): {
  response: string;
  toolCalls: Array<{ name: string; arguments: any; raw: any }>;
  format: "legacy" | "openai";
} {
  const message = result?.choices?.[0]?.message ?? result?.message;
  const openAiToolCalls = Array.isArray(message?.tool_calls);
  const rawToolCalls = Array.isArray(result?.tool_calls)
    ? result.tool_calls
    : openAiToolCalls
      ? message.tool_calls
      : [];
  const content = message?.content;
  const response = typeof result?.response === "string"
    ? result.response
    : typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part: any) => part && (part.type === "text" || typeof part.text === "string"))
            .map((part: any) => String(part.text ?? ""))
            .join("")
        : "";

  return {
    response: response.trim(),
    toolCalls: rawToolCalls.map((call: any) => ({
      name: String(call?.name ?? call?.function?.name ?? ""),
      arguments: call?.arguments ?? call?.function?.arguments,
      raw: call,
    })),
    format: (Array.isArray(result?.choices) || openAiToolCalls) ? "openai" : "legacy",
  };
}

/** Workers AI can hand tool arguments back as a string or an object. */
export function parseToolArgs(argumentsRaw: any): Record<string, any> {
  if (argumentsRaw && typeof argumentsRaw === "object") return argumentsRaw;
  if (typeof argumentsRaw === "string") {
    try {
      const parsed = JSON.parse(argumentsRaw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Loads the tail of a conversation (most recent `limit` messages, oldest
 * first) so the model has conversational continuity and the RAG query can
 * see what the customer was asking about. Missing conversation / no rows is
 * not an error — the caller just gets no thread.
 */
async function loadConversationThread(
  env: AgentEnv,
  input: AgentInput,
  limit: number,
  maxChars = MAX_THREAD_CHARS,
): Promise<string> {
  if (!input.conversationId) return "";
  try {
    const db = createDb(env.DB);
    const rows = await db
      .select({ direction: messages.direction, body: messages.body })
      .from(messages)
      .where(eq(messages.conversationId, input.conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .all();

    const parts = rows
      .filter((r) => r.body)
      .reverse()
      .map((r) => `${r.direction === "in" ? "Customer" : "Agent"}: ${r.body}`);
    if (parts.length === 0) return "";

    let text = `[Previous messages]\n${parts.join("\n")}`;
    if (text.length > maxChars) text = `[Previous messages]\n…${text.slice(-maxChars)}`;
    return text;
  } catch {
    // Conversation read problems must never fail the whole agent pipeline.
    return "";
  }
}

function normalize(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/g, " ");
}

function cache(env: AgentEnv, config: AgentConfig, key: string, value: string, ttlSeconds = config.cacheTtlSeconds): Promise<void> {
  return env.REPLY_CACHE.put(key, value, { expirationTtl: ttlSeconds }).catch(() => {});
}


/** Normalize user-facing business text without changing product identifiers. */
function normalizeBusinessText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Detect whether the customer is asking about delivery or home service. */
export function isDeliveryQuestion(message: string): boolean {
  return /\b(entrega|entregan|entregar|envio|envian|domicilio|direccion|direcciones|a casa|servicio a domicilio|reparto|llevarlo|llevarla|traeme|traerme|llevarme|mandame|enviame|cuando llega|cuando entregan|cuanto cuesta el domicilio|cuanto cobran por el domicilio)\b/.test(normalizeBusinessText(message));
}

/** Safe category-level delivery guidance when the customer has not named a model. */
export function buildGeneralDeliveryPolicyReply(message: string): string | null {
  const normalized = normalizeBusinessText(message);
  const asksToSendAddress = /\b(direccion|direcciones|mi casa|mi domicilio|esta direccion|a esta direccion)\b/.test(normalized)
    && /\b(traeme|traer|llevar|entregar|envio|enviar|mandar|domicilio|reparto)\b/.test(normalized);
  if (asksToSendAddress) {
    return "Por seguridad y para evitar comprometer una entrega que aún no está coordinada, no puedo recibir, guardar ni reenviar direcciones ni programar entregas. Primero consulta el anuncio y coordina directamente con el vendedor mediante el contacto publicado; él confirmará si puede realizar la entrega y cuándo.";
  }
  if (/\b(moto|motos|motocicleta|motocicletas)\b/.test(normalized)) {
    return "Las motocicletas anunciadas por encargo se solicitan a nombre del cliente y, una vez gestionadas, se entregan en la puerta de su domicilio. El vendedor debe confirmar el modelo, las condiciones del encargo y la fecha de entrega. No puedo confirmar pedidos, plazos ni horarios.";
  }
  if (/\b(ecoflow|delta\s*\d|river\s*\d|estacion(?:es)? de energia)\b/.test(normalized)) {
    return "Las estaciones EcoFlow anunciadas tienen entrega a domicilio gratuita. La fecha y la hora se coordinan directamente con el vendedor según la disponibilidad y la carga del vehículo. Confirma el modelo y su publicación vigente antes de coordinar.";
  }
  if (/\b(telefono|telefonos|celular|celulares|movil|moviles|smartphone)\b/.test(normalized)) {
    return "La entrega a domicilio de los teléfonos es gratuita en Sagua la Grande, Isabela de Sagua, Cifuentes y Quemado. Se realiza mediante motorina eléctrica; el horario depende de la carga disponible y se coordina directamente con el vendedor.";
  }
  return "El costo y la modalidad de entrega dependen del producto y de lo que indique su anuncio. La entrega de teléfonos en las zonas atendidas y la de estaciones EcoFlow anunciadas es gratuita. Para otros productos, el costo debe confirmarse en la ficha o directamente con el vendedor; no puedo fijar fechas ni horarios.";
}

/** Reuse the most recently named catalog model for elliptical follow-ups such as "¿y la entrega?" */
export function resolveRecentProductQuery(message: string, conversationThread: string): string {
  if (hasProductReference(message)) return message;
  if (!conversationThread) return message;
  const customerMessages = [...conversationThread.matchAll(/Customer:\s*([^\n]+)/g)].map((match) => match[1]);
  for (const previous of customerMessages.reverse()) {
    if (hasProductReference(previous)) return previous;
  }
  return message;
}

export function hasProductReference(message: string): boolean {
  return /\b(?:[a-z]{1,8}\s*\d{1,4}[a-z0-9]*|\d{1,3}[a-z]{1,4})\b/i.test(message)
    && !/\b\d+(?:gb|mb|ram|rom)\b/i.test(message);
}

/** Answer delivery only from the exact product's published delivery field. */
export function buildCatalogDeliveryReply(
  message: string,
  context: RetrievedChunk[],
  syncStatus: { stage?: string; updatedAt?: string } | null,
  now = Date.now(),
): string | null {
  if (syncStatus?.stage !== "completed" || !syncStatus.updatedAt) return null;
  const syncedAt = Date.parse(syncStatus.updatedAt);
  const ageMs = now - syncedAt;
  if (!Number.isFinite(syncedAt) || ageMs < -5 * 60_000 || ageMs > 7 * 60 * 60_000) return null;

  const normalized = normalizeBusinessText(message);
  const modelIds = [...normalized.matchAll(/\b([a-z]{1,8}\s*\d{1,4}[a-z0-9]*|\d{1,3}[a-z]{1,4})\b/g)]
    .map((match) => match[1].replace(/[^a-z0-9]/g, ""))
    .filter((key) => !/^\d+(?:gb|mb|ram|rom)$/.test(key));
  if (modelIds.length === 0) return null;

  const blocks = context.flatMap((chunk) => chunk.text.split(/(?=PRODUCTO:\s*)/));
  const matches = blocks.filter((block) => {
    const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1] ?? "";
    const compactTitle = normalizeBusinessText(title).replace(/[^a-z0-9]/g, "");
    return modelIds.some((id) => compactTitle.includes(id));
  });
  const unique = new Map<string, string>();
  for (const block of matches) {
    const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim();
    if (title) unique.set(normalizeBusinessText(title), block);
  }
  if (unique.size !== 1) return null;

  const block = [...unique.values()][0];
  const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim();
  const delivery = block.match(/^Entrega publicada:\s*(.+)$/im)?.[1]?.trim();
  if (!title || !delivery || /no especificada/i.test(delivery)) {
    return "La ficha vigente de ese producto no especifica claramente el servicio a domicilio. Para no darte una información incorrecta, debes confirmarlo con el vendedor.";
  }
  const value = normalizeBusinessText(delivery);
  if (/\b(gratis|gratuita|gratuito|sin costo|sin recargo)\b/.test(value)) {
    if (/\b(moto|motocicleta)\b/.test(normalizeBusinessText(title))) {
      return "La ficha de " + title + " indica entrega a domicilio sin costo adicional. Al ser un producto por encargo, la entrega en la puerta del domicilio se coordina directamente con el vendedor; no puedo confirmar fecha ni hora.";
    }
    return "La ficha de " + title + " indica entrega a domicilio gratuita. Se realiza mediante motorina eléctrica, sin costo adicional. El horario depende de la disponibilidad de carga y debe coordinarse previamente con el vendedor.";
  }
  if (/\b(costo adicional|costo extra|con costo|no gratuita|no gratis)\b/.test(value)) {
    return "La ficha de " + title + " indica entrega a domicilio con costo adicional. El importe y la disponibilidad deben confirmarse directamente con el vendedor; no tengo un costo de entrega confirmado en el anuncio.";
  }
  if (/\b(no ofrece|sin servicio|no dispone|no cuenta con|no hay servicio)\b/.test(value)) {
    return "La ficha de " + title + " indica que no ofrece servicio a domicilio.";
  }
  return "La ficha de " + title + " indica esta condición de entrega: " + delivery + ". Para confirmar cómo se realiza y su disponibilidad, debes coordinarlo directamente con el vendedor.";
}

/** Detect a catalog lookup that can be answered without generative guessing. */
export function isCatalogLookupQuestion(message: string): boolean {
  const normalized = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const hasModelCode = /\b(?:[a-z]{1,8}\s*\d{1,4}[a-z0-9]*|\d{1,3}[a-z]{1,4})\b/i.test(normalized)
    && !/\b\d+(?:gb|mb|ram|rom)\b/i.test(normalized);
  const asksInventory = /\b(telefonos?|celulares?|moviles?|smartphones?|ecoflow|estaciones? de energia|productos?|equipos?|catalogo|que venden|que vendes|que cosas venden|que cosas vendes|que tienen|que cosas tienen|que ofrecen|a la venta)\b/.test(normalized);
  const asksAvailability = /\b(tienes|tienen|hay|disponible|disponibilidad|en venta|venden|vendemos|queda|quedan|ofrecen|publicado|venta)\b/.test(normalized);
  const bareModel = /^(?:(?:samsung|galaxy|redmi|xiaomi|iphone|itel|tecno|infinix|motorola|honor|realme|oppo|vivo)\s+)*(?:[a-z]{1,8}\s*\d{1,4}[a-z0-9]*|\d{1,3}[a-z]{1,4})[\s?!.]*$/i.test(normalized.trim());
  return asksInventory || (hasModelCode && (asksAvailability || bareModel));
}

/** Deterministic answers for current catalog inventory and exact-model lookups. */
export function buildCatalogLookupReply(
  message: string,
  context: RetrievedChunk[],
  syncStatus: { stage?: string; updatedAt?: string } | null,
  now = Date.now(),
): string | null {
  if (syncStatus?.stage !== "completed" || !syncStatus.updatedAt) return null;
  const syncedAt = Date.parse(syncStatus.updatedAt);
  const ageMs = now - syncedAt;
  if (!Number.isFinite(syncedAt) || ageMs < -5 * 60_000 || ageMs > 7 * 60 * 60_000) return null;

  const normalized = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const blocks = context.flatMap((chunk) => chunk.text.split(/(?=PRODUCTO:\s*)/));
  const byTitle = new Map<string, { title: string; category: string; price: string; availability: string }>();
  for (const block of blocks) {
    const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim();
    if (!title) continue;
    const key = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const entry = byTitle.get(key) ?? { title, category: "", price: "", availability: "" };
    entry.category ||= block.match(/^Categor[ií]a:\s*(.+)$/im)?.[1]?.trim() ?? "";
    entry.price ||= block.match(/^Precio publicado:\s*(.+)$/im)?.[1]?.trim() ?? "";
    entry.availability ||= block.match(/^Disponibilidad publicada:\s*(.+)$/im)?.[1]?.trim() ?? "";
    byTitle.set(key, entry);
  }
  const products = [...byTitle.values()];
  if (products.length === 0) return null;

  const modelIds = [...normalized.matchAll(/\b([a-z]{1,8}\s*\d{1,4}[a-z0-9]*|\d{1,3}[a-z]{1,4})\b/g)]
    .map((match) => match[1].replace(/[^a-z0-9]/g, ""))
    .filter((key) => !/^\d+(?:gb|mb|ram|rom)$/.test(key));
  if (modelIds.length > 0) {
    const matches = products.filter((product) => {
      const title = product.title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return modelIds.some((id) => title.includes(id));
    });
    if (matches.length !== 1) {
      return "No encuentro un anuncio vigente que coincida exactamente con ese modelo en nuestro catálogo. Puedes pedir al vendedor que confirme si está disponible.";
    }
    const product = matches[0];
    const status = product.availability ? " El anuncio indica: " + product.availability + "." : "";
    const price = product.price ? " El precio publicado es " + product.price + "." : "";
    return "Sí, " + product.title + " aparece en nuestro catálogo." + price + status + " La existencia física debe confirmarse directamente con el vendedor.";
  }

  const isPhoneQuery = /\b(telefonos?|celulares?|moviles?|smartphones?)\b/.test(normalized);
  const isEcoFlowQuery = /\b(ecoflow|estaciones? de energia)\b/.test(normalized);
  let filtered = products;
  if (isPhoneQuery) {
    filtered = products.filter((product) => {
      const value = (product.title + " " + product.category).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      return /\b(telefonia|samsung|galaxy|redmi|xiaomi|iphone|itel|tecno|infinix|motorola|honor|realme|oppo|vivo)\b/.test(value);
    });
  } else if (isEcoFlowQuery) {
    filtered = products.filter((product) => /\b(ecoflow|delta|river)\b/i.test(product.title));
  }
  if (filtered.length === 0) {
    const label = isPhoneQuery ? "teléfonos" : isEcoFlowQuery ? "estaciones de energía EcoFlow" : "productos";
    return "Ahora mismo no encuentro anuncios vigentes de " + label + " en nuestro catálogo. El vendedor puede confirmar si hay alguna publicación nueva pendiente de sincronizar.";
  }
  const label = isPhoneQuery ? "teléfonos" : isEcoFlowQuery ? "estaciones de energía EcoFlow" : "productos";
  const lines = filtered.slice(0, 20).map((product) => {
    const details = [product.price, product.availability].filter(Boolean).join(" · ");
    return "• " + product.title + (details ? " — " + details : "");
  });
  const introduction = isEcoFlowQuery ? "Estas son las " : "Estos son los ";
  return introduction + label + " que aparecen en nuestro catálogo publicado:\n" + lines.join("\n") + "\n\nLa disponibilidad física debe confirmarse directamente con el vendedor.";
}

/**
 * Answers payment questions directly from the approved store policy.
 * Never estimates exchange rates or implies CUP payment is accepted for USD ads.
 */
export function buildPaymentPolicyReply(message: string): string | null {
  const normalized = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const asksZelle = /\bzelle\b/.test(normalized);
  const asksCup = /\bcup\b|pesos? cubanos?|moneda nacional/.test(normalized);
  const asksDollarRate = /\b(dolar|dolares|cambio|tasa|cotizacion|cotizar|valoras|valoracion)\b/.test(normalized)
    && /\b(cuanto|a como|valor|precio|cambio|tasa|cotizacion|cotizar|valoras)\b/.test(normalized);
  const asksTransfer = /\b(transferencia|transferencias|transferir)\b/.test(normalized);
  const asksUsd = /\busd\b|\bdolares?\b|\ben dolares?\b/.test(normalized);
  const asksPayment = /\b(pago|pagar|pagarte|pagarles|aceptan|aceptas|reciben|recibir|cobran|metodo|forma|moneda|transferencia|efectivo|cash|tarjeta)\b/.test(normalized);

  if (asksDollarRate) {
    return "No ofrecemos una tasa fija para valorar el dólar. La relación entre USD y CUP fluctúa, por lo que los precios de nuestros anuncios se mantienen en la moneda publicada y no hacemos conversiones estimadas.";
  }
  if (asksZelle) {
    return "Sí, aceptamos Zelle para los anuncios publicados en USD. Se aplica un recargo del 10% sobre el precio publicado. Si me dices qué producto te interesa, puedo indicarte el total exacto por Zelle.";
  }
  if (asksCup) {
    return "No aceptamos efectivo en CUP ni transferencias en CUP para los anuncios publicados en USD. Los precios se mantienen en la moneda indicada en cada anuncio.";
  }
  if (asksTransfer && asksUsd) {
    return "Los precios de los anuncios se publican en USD, pero no tengo confirmada la aceptación de transferencias en USD. El método confirmado es Zelle, con un recargo del 10%. Para otra modalidad, debes consultarlo directamente con el vendedor.";
  }
  if (asksTransfer) {
    return "No aceptamos transferencias en CUP para los anuncios publicados en USD. Las transferencias en USD no están confirmadas por el asistente; el método confirmado es Zelle, con un recargo del 10%.";
  }
  if (asksUsd) {
    return "Los precios de nuestros anuncios pueden estar publicados en USD. El método de pago confirmado por el asistente es Zelle, con un recargo del 10%. No puedo confirmar efectivo ni otras modalidades en USD; debes consultarlas con el vendedor.";
  }
  if (asksPayment) {
    return "Los precios se respetan en la moneda indicada en cada anuncio. Para publicaciones en USD, el método confirmado es Zelle con un recargo del 10%. No aceptamos efectivo ni transferencias en CUP para esos anuncios. Otras modalidades en USD deben confirmarse con el vendedor.";
  }
  return null;
}

/**
 * When a customer asks about Zelle and then names a product, calculate the
 * 10% surcharge from that product's verified catalog price. Conversation
 * context is required so ordinary catalog replies never assume Zelle.
 */
export function buildZelleTotalReply(catalogReply: string, conversationThread: string, explicitCurrentZelleIntent = false): string | null {
  const normalizedThread = conversationThread.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const hasZellePaymentExchange =
    /Customer:[^\n]*\bzelle\b[\s\S]*Agent:[^\n]*aceptamos Zelle/i.test(normalizedThread);
  if (!hasZellePaymentExchange && !explicitCurrentZelleIntent) return null;

  const priceMatch = catalogReply.match(/\bprecio publicado es\s+([\d,.]+)\s*USD\b/i);
  if (!priceMatch) return null;
  const publishedPrice = Number(priceMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(publishedPrice) || publishedPrice <= 0) return null;

  const total = Math.round(publishedPrice * 1.1 * 100) / 100;
  const formattedTotal = Number.isInteger(total) ? String(total) : total.toFixed(2);
  return catalogReply + " Con el recargo del 10% por Zelle, el total es " + formattedTotal + " USD.";
}

/**
 * Answers only stable, explicitly approved category policies. This path does
 * not confirm that a particular model is listed, available, or orderable.
 */
export function buildStorePolicyOnlyReply(message: string): string | null {
  const normalized = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const asksConditions = /\b(incluye|incluyen|incluido|incluidos|trae|viene con|que trae|que incluye|accesorios|garantia|garantía|entrega|envio|envío|domicilio|prueba|devolucion|devolución|reparacion|reparación|encargo|encargar|encargue|pedido|proceso|pasos|funciona)\b/.test(normalized);
  if (!asksConditions) return null;

  if (/\b(ecoflow|delta\s*\d|river\s*\d)\b/.test(normalized)) {
    if (/\b(garantia|garantía|prueba|falla|fallo|responsabilidad|devolucion|devolución|reparacion|reparación)\b/.test(normalized)) {
      return "Las estaciones EcoFlow anunciadas por el negocio no tienen garantía comercial del vendedor. Antes de la compra, el equipo se prueba durante tiempo suficiente en presencia del comprador. Después de la entrega, el negocio no se responsabiliza por daños derivados de uso inadecuado o manipulación incorrecta. Para confirmar las condiciones del modelo concreto, consulta su anuncio o al vendedor.";
    }
    if (/\b(entrega|envio|envío|domicilio)\b/.test(normalized)) {
      return "La entrega a domicilio de las estaciones EcoFlow anunciadas es gratuita. La fecha y la hora se coordinan directamente con el vendedor según la disponibilidad y la carga del vehículo. La publicación vigente debe confirmar el modelo y su modalidad de venta.";
    }
    if (/\b(incluye|incluyen|incluido|incluidos|trae|viene con|que trae|que incluye|accesorios|bateria|batería|baterias|baterías)\b/.test(normalized)) {
      return "En las estaciones EcoFlow anunciadas, la compra incluye únicamente la caja y la unidad principal, salvo que el anuncio específico indique expresamente otra cosa. Las baterías de expansión se venden por separado y actualmente no hay baterías extra disponibles. No puedo confirmar desde esta consulta si ese modelo concreto está publicado; revisa el anuncio vigente o consúltalo con el vendedor.";
    }
  }

  if (/\b(moto|motos|motocicleta|motocicletas)\b/.test(normalized)) {
    if (/\b(garantia|garantía|devolucion|devolución|reparacion|reparación)\b/.test(normalized)) {
      return "Las motocicletas anunciadas por encargo son nuevas y se gestionan a nombre del cliente. La garantía corresponde al fabricante; su cobertura, duración y procedimiento deben verificarse para el modelo concreto. Como el equipo está fuera de Cuba, una devolución o reparación internacional puede ser difícil, no viable y costosa, y el transporte podría correr por cuenta del cliente. Antes de encargar, confirma las condiciones oficiales con el vendedor.";
    }
    if (/\b(entrega|envio|envío|domicilio)\b/.test(normalized)) {
      return "Las motocicletas anunciadas por encargo se entregan directamente en la puerta del domicilio del cliente. La fecha y la hora deben coordinarse con el vendedor; no se confirman automáticamente. La modalidad y disponibilidad del modelo deben verificarse en el anuncio vigente.";
    }
    if (/\b(por encargo|encargar|encargo|pedido|proceso|pasos|incluye|incluyen|nueva|nuevo|como funciona|cómo funciona)\b/.test(normalized)) {
      return "El proceso es solicitar la motocicleta anunciada por encargo a nombre del propio cliente. Antes de confirmar, el vendedor debe verificar el modelo, el precio y las condiciones concretas del pedido. La entrega se realiza en la puerta del domicilio una vez coordinada con el vendedor. No puedo confirmar un pedido, anticipo, plazo ni fecha de llegada: esos detalles debe confirmarlos directamente el vendedor. La garantía corresponde al fabricante y sus condiciones dependen del modelo.";
    }
  }
  return null;
}

/** Greetings may be answered without product data; substantive questions may not. */
export function isSimpleGreeting(message: string): boolean {
  const normalized = message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[¿?¡!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:(?:hola|ola)(?: buenas(?: tardes| noches)?| buenos dias)?|buenas(?: tardes| noches)?|buenos dias|saludos|hey|hello|hi|gracias|muchas gracias|ok|okay|perfecto)(?: 😊| 🙏)?$/.test(normalized);
}

/**
 * Answers questions about the fixed bundle included with listed phones.
 * Requires both a matching product block and the pinned phone policy chunk.
 */
export function buildPhoneBundleReply(message: string, context: RetrievedChunk[]): string | null {
  const normalizedQuestion = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const asksAboutBundle = /\b(incluye|incluyen|incluido|incluidos|trae|viene con|que trae|accesorios|garantia|dias de garantia)\b/.test(normalizedQuestion);
  if (!asksAboutBundle) return null;

  const modelIds = [...normalizedQuestion.matchAll(/\b[a-z]{1,6}\d{1,4}[a-z0-9]*\b/g)].map((match) => match[0]);
  if (modelIds.length === 0) return null;

  const productBlocks = context.flatMap((chunk) => chunk.text.split(/(?=PRODUCTO:\s*)/));
  const matches = productBlocks.filter((block) => {
    const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1] ?? "";
    const normalizedTitle = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const isPhone = /\b(samsung|galaxy|redmi|xiaomi|iphone|itel|tecno|infinix|motorola|honor|realme|oppo|vivo)\b/.test(normalizedTitle);
    return isPhone && modelIds.some((modelId) => new RegExp("(^|[^a-z0-9])" + modelId + "([^a-z0-9]|$)").test(normalizedTitle));
  });
  if (matches.length !== 1) return null;

  // The fixed phone bundle is sourced from the permanent code policy, not a
  // pinned RAG chunk that can be dropped by the context-size limit.
  const policy = STORE_POLICY.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!["cover de fabrica", "cable", "cargador", "mica protectora", "15 dias de garantia"].every((fact) => policy.includes(fact))) {
    return null;
  }

  const title = matches[0].match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim();
  if (!title) return null;
  return "La compra de " + title + " incluye cover de fábrica, cable, cargador original y mica protectora de cristal templado. Además, cuenta con 15 días de garantía.";
}

/**
 * Exact catalog-price answers are safer and more reliable than asking a
 * generative model to restate a number. Only answer when a completed sync is
 * recent and one unambiguous product block in retrieved context contains the
 * requested model identifier and an explicit published price.
 */
export function buildCatalogPriceReply(
  message: string,
  context: RetrievedChunk[],
  syncStatus: { stage?: string; updatedAt?: string } | null,
  now = Date.now(),
): string | null {
  if (syncStatus?.stage !== "completed" || !syncStatus.updatedAt) return null;
  const syncedAt = Date.parse(syncStatus.updatedAt);
  const ageMs = now - syncedAt;
  // Catalog sync is intentionally throttled to six hours; allow one hour of cron/scheduling slack.
  // Keep this freshness limit aligned with the six-hour sync cooldown.
  // A 30-minute freshness gate made valid, completed catalog data unusable for most of that interval.
  if (!Number.isFinite(syncedAt) || ageMs < -5 * 60_000 || ageMs > 7 * 60 * 60_000) return null;

  const normalizedQuestion = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!/\b(precio|cuanto cuesta|cuesta|vale|valor|costo|coste)\b/.test(normalizedQuestion)) return null;

  const modelIds = [...normalizedQuestion.matchAll(/\b[a-z]{1,6}\d{1,4}[a-z0-9]*\b/g)].map((match) => match[0]);
  if (modelIds.length === 0) return null;

  const productBlocks = context.flatMap((chunk) => chunk.text.split(/(?=PRODUCTO:\s*)/));
  const matches = productBlocks.filter((block) => {
    const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1] ?? "";
    const normalizedTitle = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return modelIds.some((modelId) => new RegExp(`(^|[^a-z0-9])${modelId}([^a-z0-9]|$)`).test(normalizedTitle));
  });
  if (matches.length !== 1) return null;

  const title = matches[0].match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim();
  const price = matches[0].match(/^Precio publicado:\s*(.+)$/im)?.[1]?.trim();
  if (!title || !price) return null;

  return `El precio publicado de ${title} es ${price}. La disponibilidad física debe confirmarse directamente con el vendedor.`;
}
