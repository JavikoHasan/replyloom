import type { AgentConfig, AgentContext, AgentEnv, AgentInput, AgentReply, RetrievedChunk, ToolSchema } from "./types";
import { classifyIntent, privateLocationReply, redactSensitive, shouldEscalateToHuman } from "./guardrails";
import { createDb, eq, desc, messages } from "@workspace/db";
import { retrieveContext } from "./rag";
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
const THREAD_MESSAGE_LIMIT = 4;

const NO_INFO_REPLY =
  "Soy el asistente virtual de Cell Phone Store. Solo estoy autorizado para informar sobre los productos publicados y datos que estén verificados. No tengo información confirmada sobre esa consulta; para evitar errores, puedes consultarlo directamente con el vendedor.";
const CLARIFY_REPLY =
  "¡Hola! Soy el asistente virtual de Cell Phone Store. Puedo ayudarte con información sobre los productos de nuestro catálogo.";

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
  const replyCacheTtlSeconds = catalogOnlyBusiness
    ? Math.min(config.cacheTtlSeconds, 300)
    : config.cacheTtlSeconds;

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

  // ── 1) Cheap exact-match cache — zero model spend on repeat FAQs ──
  const cacheKey = `${cachePrefixes.replies}${config.workspaceId}:${catalogOnlyBusiness ? "catalog-v2:" : ""}${normalize(message)}`;
  if (replyCacheTtlSeconds > 0) {
    const cached = await env.REPLY_CACHE.get(cacheKey);
    if (cached) {
      return { text: cached, usedTools: [], usedContext: [], blocked: false, cached: true };
    }
  }

  // ── 1b) Conversation thread — gives the model continuity for follow-ups
  // like "and shipping?" without a full message-history tool call, and
  // grounds the RAG query in what the customer was actually asking about. ──
  const thread = !catalogOnlyBusiness && input.conversationId ? await loadConversationThread(env, input, THREAD_MESSAGE_LIMIT) : "";
  const query = thread ? `${thread}\\n\\n${message}` : message;
  // This store is a product-information-only assistant: do not expose CRM
  // customer/order tools or arbitrary workspace webhooks to its model.
  const [gate, workspaceTools, context] = await Promise.all([
    classifyIntent(env, config, message),
    catalogOnlyBusiness ? Promise.resolve([]) : listWorkspaceWebhookTools(env, config.workspaceId),
    retrieveContext(env, config, query, catalogOnlyBusiness ? "revolico-sagua.pages.dev" : undefined, catalogOnlyBusiness ? ["condiciones-venta-telefonos"] : []),
  ]);

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
    return { text: redactSensitive(text), usedTools, usedContext: [], blocked: false, cached: false };
  }

  // ── 4+5) Grounded generation (context + tools, at most 2 tool turns) ──
  const { text, usedTools } = await generateReply(ctx, message, context, toolSchemas, thread);
  const safeText = redactSensitive(text || "Let me get a team member to help with that.");

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
    } catch {
      // Primary model failed (after the gateway's own retries) — fail down to
      // a lighter model rather than letting the reply die for the customer.
      result = await ctx.env.AI.run(FALLBACK_GENERATOR, body, runOptions);
    }

    const toolCalls: any[] = result?.tool_calls ?? [];
    if (toolCalls.length === 0) {
      finalText = String(result?.response ?? "").trim();
      break;
    }

    for (const call of toolCalls) {
      const name = String(call?.name ?? "");
      if (!name) continue;
      const args = parseToolArgs(call?.arguments);
      const output = await executeTool(ctx.env, ctx.workspaceId, name, args, ctx, registry);
      usedTools.push(name);
      chatMessages.push({ role: "assistant", content: null, tool_calls: [call] });
      chatMessages.push({ role: "tool", name, content: output });
    }
  }

  return { text: finalText, usedTools };
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
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
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

/** Greetings may be answered without product data; substantive questions may not. */
function isSimpleGreeting(message: string): boolean {
  return /^(hola|buenas(?: tardes| noches)?|buenos días|saludos|hey|hello|hi|gracias|muchas gracias|ok|okay|perfecto)[!.\s😊🙏]*$/iu.test(message.trim());
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
  if (!Number.isFinite(syncedAt) || ageMs < -5 * 60_000 || ageMs > 30 * 60_000) return null;

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
