import type { AgentConfig, AgentContext, AgentEnv, AgentInput, AgentReply, RetrievedChunk, ToolSchema } from "./types";
import { classifyIntent, privateLocationReply, redactSensitive, shouldEscalateToHuman } from "./guardrails";
import { createDb, eq, desc, sql, messages } from "@workspace/db";
import { retrieveContext, retrieveCatalogChunks } from "./rag";
import { buildSystemPrompt } from "./system-prompt";
import { STORE_POLICY } from "./store-policy";
import { cachePrefixes } from "./config";
import { gatewayRunOptions, FALLBACK_GENERATOR } from "./gateway";
import { executeTool, buildDefaultRegistry, listWorkspaceWebhookTools, workspaceToolToSchema } from "./tools";
import { customerPhoneFromJid } from "./util";
import { normalizeStoreCatalogQuery } from "./catalog-query-normalization";
import { buildShortCatalogProductSelectionReply, buildUniversalCatalogTechnicalReply, isShortCatalogProductSelection, isUniversalCatalogTechnicalQuestion } from "./universal-catalog-intelligence";

const registry = buildDefaultRegistry();
const MAX_TURNS = 2; // generation loop depth, not conversation turns
const MAX_REPLY_TOKENS = 400;
const MAX_INPUT_CHARS = 4000;
const MAX_THREAD_CHARS = 1500;
const THREAD_MESSAGE_LIMIT = 12;

const NO_INFO_REPLY =
  "¡Hola! 👋 Soy el asistente virtual de Cell Phone Store - Sagua la Grande. Soy una IA de apoyo comercial y, en ocasiones, puedo tener dificultades para interpretar alguna consulta o encontrar una respuesta confirmada en la información publicada. Para ayudarte mejor, intenta formularla de otra manera o dime qué producto te interesa. Mi prioridad es ofrecerte información correcta y no inventar datos. Si necesitas ayuda adicional, puedes contactar directamente con el vendedor por WhatsApp: https://wa.me/5354590237.";
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

  // Answer brief questions about the assistant itself without opening general chat.
  if (catalogOnlyBusiness) {
    const identityReply = buildAssistantIdentityReply(message);
    if (identityReply) {
      return { text: identityReply, usedTools: [], usedContext: [], blocked: false, cached: false };
    }
  }

  // Public business contact is a commercial FAQ, not an unknown/off-topic request.
  if (catalogOnlyBusiness) {
    const contactReply = buildBusinessContactReply(message);
    if (contactReply) {
      return { text: contactReply, usedTools: [], usedContext: [], blocked: false, cached: false };
    }
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

  // A short product selection (for example, "Un A16", "la nevera" or
  // "una bicicleta eléctrica") is a catalog lookup, not a request for
  // private/internal data. Resolve it from listing titles BEFORE intent
  // classification so future categories are supported without hard-coded
  // model identifiers or category names.
  if (catalogOnlyBusiness && isShortCatalogProductSelection(message)) {
    try {
      const syncStatus = await env.REPLY_CACHE
        .get<{ stage?: string; updatedAt?: string }>("revolico:catalog-sync:status", "json")
        .catch(() => null);
      const selectionContext = await retrieveCatalogChunks(env, config, "revolico-sagua.pages.dev");
      const selectionReply = buildShortCatalogProductSelectionReply(message, selectionContext, syncStatus);
      if (selectionReply) {
        console.info("[catalog-agent] pre-classifier-product-selection", {
          modelReferencePresent: true,
          contextRows: selectionContext.length,
          responsePresent: true,
        });
        return { text: selectionReply, usedTools: [], usedContext: selectionContext, blocked: false, cached: false };
      }
      // The model selection is still legitimate when the catalog sync is
      // stale or unavailable; explain the verification limitation instead
      // of allowing a false privacy classification to reject the customer.
      return {
        text: "He identificado el modelo que mencionas, pero ahora mismo no puedo verificar una ficha de catálogo suficientemente actualizada. Para evitar darte un precio o una disponibilidad incorrectos, el vendedor puede confirmártelo directamente por WhatsApp: https://wa.me/5354590237.",
        usedTools: [],
        usedContext: selectionContext,
        blocked: false,
        cached: false,
      };
    } catch (error) {
      console.warn("[catalog-agent] pre-classifier-product-selection-error", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return { text: NO_INFO_REPLY, usedTools: [], usedContext: [], blocked: false, cached: false };
    }
  }

  const asksTechnicalProductQuestion = isUniversalCatalogTechnicalQuestion(message) || /\b(propiedades|caracteristicas|especificaciones|especificacion|4g|5g|conectividad|red movil|memoria|almacenamiento|ram|rom|procesador|pantalla|camara|bateria|carga|nfc|sistema operativo|resolucion|hz|potencia|cilindrada|cc|transmision|frenos|suspension|velocidad|combustible|capacidad|wh|kwh|lifepo4|quimica|expandible|ampliable|salida|entrada solar)\b/.test(normalizeStoreCatalogQuery(message));
  if (catalogOnlyBusiness && asksTechnicalProductQuestion) {
    try {
      const syncStatus = await env.REPLY_CACHE
        .get<{ stage?: string; updatedAt?: string }>("revolico:catalog-sync:status", "json")
        .catch(() => null);
      const technicalContext = await retrieveCatalogChunks(env, config, "revolico-sagua.pages.dev");
      const universalTechnicalReply = buildUniversalCatalogTechnicalReply(message, contextualProductQuery, technicalContext, syncStatus);
      const technicalReply = universalTechnicalReply
        ?? (hasProductReference(contextualProductQuery)
          ? buildPhoneTechnicalReply(message, contextualProductQuery, technicalContext, syncStatus)
          : null);
      if (technicalReply) {
        return { text: technicalReply, usedTools: [], usedContext: technicalContext, blocked: false, cached: false };
      }
      return {
        text: "No pude identificar una ficha única y verificable para responder esa pregunta. Dime el nombre o modelo exacto del producto y volveré a revisar el catálogo; prefiero no inventar especificaciones.",
        usedTools: [],
        usedContext: technicalContext,
        blocked: false,
        cached: false,
      };
    } catch (error) {
      console.warn("[catalog-agent] deterministic-technical-error", { errorType: error instanceof Error ? error.name : typeof error });
      return { text: NO_INFO_REPLY, usedTools: [], usedContext: [], blocked: false, cached: false };
    }
  }



  // Resolve short product-policy follow-ups before the generic intent classifier.
  if (catalogOnlyBusiness) {
    const phoneBundleReply = buildPhoneBundleReply(message, [], contextualProductQuery);
    if (phoneBundleReply) {
      return { text: phoneBundleReply, usedTools: [], usedContext: [], blocked: false, cached: false };
    }
    const contextualPolicyReply = buildStorePolicyOnlyReply(message, contextualProductQuery);
    if (contextualPolicyReply) {
      return { text: contextualPolicyReply, usedTools: [], usedContext: [], blocked: false, cached: false };
    }
  }

  // Explicit requests for a same-day/next-day delivery need a safe, deterministic
  // handoff. Never let the language model imply that a slot has been booked.
  if (catalogOnlyBusiness && isDeliverySchedulingQuestion(message)) {
    const deliverySubject = /\b(ecoflow|estacion(?:es)? de energia|delta|river)\b/i.test(contextualProductQuery)
      ? " de las estaciones de energía anunciadas"
      : /\b(telefono|telefonos|celular|celulares|samsung|galaxy|redmi|iphone|f07|a16|a17)\b/i.test(contextualProductQuery)
        ? " del teléfono que te interesa"
        : "";
    return {
      text: "No puedo confirmar ni programar una entrega" + deliverySubject + " para hoy o mañana. El vendedor debe confirmar la disponibilidad del producto, la carga del vehículo y el horario. Escríbele directamente por WhatsApp para coordinarlo: https://wa.me/5354590237.",
      usedTools: [],
      usedContext: [],
      blocked: false,
      cached: false,
    };
  }

  // Reservation requests must be handed to the seller; the bot cannot
  // hold inventory, accept deposits, or confirm an order.
  if (catalogOnlyBusiness) {
    const reservationReply = buildReservationPolicyReply(message, contextualProductQuery);
    if (reservationReply) {
      return { text: reservationReply, usedTools: [], usedContext: [], blocked: false, cached: false };
    }
  }

  // Clear purchase interest must continue the last exact product lookup instead of
  // falling through to the generic no-information response; a bare yes is ambiguous.
  if (catalogOnlyBusiness && isPurchaseInterestMessage(message) && hasProductReference(contextualProductQuery)) {
    try {
      const syncStatus = await env.REPLY_CACHE
        .get<{ stage?: string; updatedAt?: string }>("revolico:catalog-sync:status", "json")
        .catch(() => null);
      const allCatalogChunks = await retrieveCatalogChunks(env, config, "revolico-sagua.pages.dev");
      const catalogReply = buildCatalogLookupReply(contextualProductQuery, allCatalogChunks, syncStatus);
      const purchaseReply = buildPurchaseInterestReply(contextualProductQuery, catalogReply);
      if (purchaseReply) {
        return { text: purchaseReply, usedTools: [], usedContext: allCatalogChunks, blocked: false, cached: false };
      }
    } catch (error) {
      console.warn("[catalog-agent] purchase-interest-lookup-error", { errorType: error instanceof Error ? error.name : typeof error });
    }
  }

  // A short functionality follow-up such as "¿sí funciona?" refers to the
  // last phone discussed. State only the store's verified new/sealed status
  // and 15-day warranty; never claim to have tested a particular unit.
  if (catalogOnlyBusiness && isPhoneFunctionalityQuestion(message, contextualProductQuery)) {
    return {
      text: "El teléfono que consultaste se vende nuevo, sellado y original. La compra incluye 15 días de garantía. No puedo probar una unidad concreta desde este chat; para confirmar cualquier detalle antes de comprar, puedes escribir directamente al vendedor: https://wa.me/5354590237.",
      usedTools: [],
      usedContext: [],
      blocked: false,
      cached: false,
    };
  }

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
        ?? buildGeneralDeliveryPolicyReply(message, contextualProductQuery);
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
  if (catalogOnlyBusiness && asksZelleNow && hasProductReference(contextualProductQuery) && (hasProductReference(message) || asksForZelleTotal(message))) {
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
      const exactArticleSelection = isShortCatalogProductSelection(message) && hasProductReference(message)
        ? buildShortCatalogProductSelectionReply(message, allCatalogChunks, syncStatus)
        : null;
      const catalogLookupReply = exactArticleSelection
        ?? buildCatalogLookupReply(contextualProductQuery, allCatalogChunks, syncStatus);
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

  // Any short article-led selection (for example, "la nevera" or "una bicicleta")
  // is resolved against the live catalog, not against a hard-coded product list.
  if (catalogOnlyBusiness && isShortCatalogProductSelection(message) && !isCatalogLookupQuestion(message)) {
    try {
      const syncStatus = await env.REPLY_CACHE
        .get<{ stage?: string; updatedAt?: string }>("revolico:catalog-sync:status", "json")
        .catch(() => null);
      const selectionContext = await retrieveCatalogChunks(env, config, "revolico-sagua.pages.dev");
      const selectionReply = buildShortCatalogProductSelectionReply(message, selectionContext, syncStatus);
      if (selectionReply) {
        return { text: selectionReply, usedTools: [], usedContext: selectionContext, blocked: false, cached: false };
      }
    } catch (error) {
      console.warn("[catalog-agent] deterministic-product-selection-error", { errorType: error instanceof Error ? error.name : typeof error });
      return { text: NO_INFO_REPLY, usedTools: [], usedContext: [], blocked: false, cached: false };
    }
  }

  // ── 1b) Conversation thread — gives the model continuity for follow-ups
  // like "and shipping?" without a full message-history tool call, and
  // grounds the RAG query in what the customer was actually asking about. ──
  const currentMessageHasModel = hasProductReference(message);
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

  // Deterministic technical replies precede generation so verified listing
  // fields are returned consistently; missing specifications stay unknown.
  if (catalogOnlyBusiness) {
    const syncStatus = await env.REPLY_CACHE
      .get<{ stage?: string; updatedAt?: string }>("revolico:catalog-sync:status", "json")
      .catch(() => null);
    const technicalContext = await retrieveCatalogChunks(env, config, "revolico-sagua.pages.dev").catch(() => context);
    const technicalReply = buildPhoneTechnicalReply(message, contextualProductQuery, technicalContext, syncStatus);
    if (technicalReply) {
      return { text: technicalReply, usedTools: [], usedContext: technicalContext, blocked: false, cached: false };
    }
  }

  // Resolve short price follow-ups against the full, fresh catalog and the
  // most recent product context (e.g. "F07" followed by "Precio").
  if (catalogOnlyBusiness && /\b(precio|cuanto cuesta|cuesta|vale|valor|costo|coste)\b/.test(normalizeStoreCatalogQuery(message))) {
    try {
      const syncStatus = await env.REPLY_CACHE
        .get<{ stage?: string; updatedAt?: string }>("revolico:catalog-sync:status", "json")
        .catch(() => null);
      const allCatalogChunks = await retrieveCatalogChunks(env, config, "revolico-sagua.pages.dev");
      const priceQuestion = message + " " + contextualProductQuery;
      const exactPriceReply = buildCatalogPriceReply(priceQuestion, allCatalogChunks, syncStatus);
      if (exactPriceReply) {
        return { text: exactPriceReply, usedTools: [], usedContext: allCatalogChunks, blocked: false, cached: false };
      }

      const hasProductContext = hasProductReference(contextualProductQuery)
        || isCatalogLookupQuestion(contextualProductQuery)
        || isShortCatalogProductSelection(contextualProductQuery);
      if (!hasProductContext) {
        return {
          text: "Claro. ¿De cuál producto quieres saber el precio? Puedes decirme el modelo o el nombre del artículo.",
          usedTools: [],
          usedContext: allCatalogChunks,
          blocked: false,
          cached: false,
        };
      }

      const catalogPriceLookup = buildCatalogLookupReply(contextualProductQuery, allCatalogChunks, syncStatus);
      if (catalogPriceLookup) {
        const zellePriceReply = buildZelleTotalReply(catalogPriceLookup, recentThread);
        return {
          text: zellePriceReply ?? catalogPriceLookup,
          usedTools: [],
          usedContext: allCatalogChunks,
          blocked: false,
          cached: false,
        };
      }
      return {
        text: "Ahora mismo no puedo verificar un precio actualizado para ese producto en el catálogo. El vendedor puede confirmarlo directamente por WhatsApp: https://wa.me/5354590237.",
        usedTools: [],
        usedContext: allCatalogChunks,
        blocked: false,
        cached: false,
      };
    } catch (error) {
      console.warn("[catalog-agent] contextual-price-lookup-error", { errorType: error instanceof Error ? error.name : typeof error });
      return { text: NO_INFO_REPLY, usedTools: [], usedContext: [], blocked: false, cached: false };
    }
  }

  // Answer the store's fixed phone bundle directly from the permanent code policy.
  // This avoids dependence on a policy chunk being selected by RAG.
  if (catalogOnlyBusiness) {
    const phoneBundleReply = buildPhoneBundleReply(message, context, contextualProductQuery);
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
    const policyReply = buildStorePolicyOnlyReply(message, contextualProductQuery);
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
      .orderBy(desc(messages.createdAt), desc(sql`rowid`))
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
  return /\b(entrega|entregan|entregar|envio|envian|domicilio|direccion|direcciones|a casa|servicio a domicilio|reparto|llevarlo|llevarla|traeme|traerme|llevarme|mandame|enviame|cuando llega|cuando entregan|cuanto cuesta el domicilio|cuanto cobran por el domicilio)\b/.test(normalizeStoreCatalogQuery(message));
}

/** Detect explicit requests for delivery today/tomorrow; these must never be booked by the bot. */
export function isDeliverySchedulingQuestion(message: string): boolean {
  const normalized = normalizeStoreCatalogQuery(message);
  const asksForDelivery = /\b(necesito|quiero|quisiera|pueden traer|me pueden traer|traigan|lleven|entreguen|manden|envien|me lo traen|me lo llevan|me lo entregan)\b/.test(normalized);
  const namesTime = /\b(hoy|manana|pasado manana|esta tarde|esta noche)\b/.test(normalized);
  return asksForDelivery && namesTime;
}

/** Detect clear purchase-interest phrases; a bare "sí" is intentionally ambiguous. */
export function isPurchaseInterestMessage(message: string): boolean {
  const normalized = normalizeStoreCatalogQuery(message);
  return /\b(me interesa|estoy interesado|estoy interesada|lo quiero|la quiero|quiero comprarlo|quiero comprarla|quiero ese|quiero esa|me lo llevo|me la llevo)\b/.test(normalized);
}

/** Continue an exact catalog lookup without inventing stock or a reservation. */
export function buildPurchaseInterestReply(productQuery: string, catalogReply: string | null): string | null {
  if (!hasProductReference(productQuery)) return null;
  if (!catalogReply || /no encuentro un anuncio vigente|no aparece en nuestro catalogo/i.test(catalogReply)) {
    return "¡Entendido! Para evitar darte información incorrecta, el vendedor debe confirmar que el producto que consultaste siga anunciado y físicamente disponible. Puedes escribirle directamente por WhatsApp: https://wa.me/5354590237.";
  }
  if (!/aparece en nuestro catalogo/i.test(normalizeBusinessText(catalogReply))) return null;
  return "¡Perfecto! " + catalogReply + " Si deseas continuar con la compra, escribe al vendedor por WhatsApp: https://wa.me/5354590237. Indícale que te interesa este modelo para que confirme la existencia física y coordine contigo.";
}

/** Recognize a phone-functionality follow-up only when the previous turn named a phone. */
export function isPhoneFunctionalityQuestion(message: string, productQuery: string): boolean {
  const normalizedMessage = normalizeStoreCatalogQuery(message);
  const normalizedQuery = normalizeStoreCatalogQuery(productQuery);
  const asksFunctionality = /\b(funciona|funcionamiento|sirve|funcionar)\b/.test(normalizedMessage);
  const namesPhone = /\b(telefono|telefonos|celular|celulares|samsung|galaxy|redmi|iphone|f07|a16|a17|a56)\b/.test(normalizedQuery);
  return asksFunctionality && namesPhone;
}

/** Deterministic reservation guidance; never claims a hold or booking exists. */
export function buildReservationPolicyReply(message: string, contextualProductQuery = ""): string | null {
  const normalized = normalizeStoreCatalogQuery(message + " " + contextualProductQuery);
  const asksReservation = /\b(reservar|reserva|reservas|apartar|apartame|apartarlo|apartarla|separar|separame|guardame)\b/.test(normalizeStoreCatalogQuery(message));
  if (!asksReservation) return null;
  if (/\b(moto|motos|motocicleta|motocicletas|xmx|izuki|huracan)\b/.test(normalized)) {
    return "Las motocicletas se gestionan por encargo a nombre del cliente. No puedo reservar ni formalizar el pedido desde este chat, ni confirmar anticipos, plazos o fecha de llegada. El vendedor debe confirmar el modelo, el precio y las condiciones del encargo directamente por WhatsApp: https://wa.me/5354590237.";
  }
  if (/\b(telefono|telefonos|celular|celulares|samsung|galaxy|redmi|iphone|f07|a16|a17)\b/.test(normalized)) {
    return "No puedo apartar ni garantizar una reserva desde este chat. El vendedor debe confirmar que el teléfono siga físicamente disponible y coordinar contigo si puede reservarlo y bajo qué condiciones. Escríbele directamente por WhatsApp: https://wa.me/5354590237; indícale el modelo y para cuándo lo necesitas.";
  }
  return "No puedo formalizar ni garantizar reservas desde este chat. El vendedor debe confirmar la disponibilidad física y las condiciones de cualquier reserva directamente por WhatsApp: https://wa.me/5354590237.";
}

/** Safe category-level delivery guidance when the customer has not named a model. */
export function buildGeneralDeliveryPolicyReply(message: string, contextualProductQuery = ""): string | null {
  const normalized = normalizeStoreCatalogQuery(message + " " + contextualProductQuery);
  const asksToSendAddress = /\b(direccion|direcciones|mi casa|mi domicilio|esta direccion|a esta direccion)\b/.test(normalized)
    && /\b(traeme|traer|traiga|traigan|llevar|lleve|lleven|lleves|entrega|entregar|envio|enviar|mandar|manda|pasar|pasas|pasarle|coordinar|disponible|domicilio|reparto)\b/.test(normalized);
  if (asksToSendAddress) {
    return "No envíes tu dirección a este asistente: no recibe, guarda ni reenvía direcciones. Para coordinar la entrega, escríbele directamente al vendedor por WhatsApp: https://wa.me/5354590237. Indícale el modelo o producto que deseas comprar, tu nombre, un número de teléfono para contactarte y, si necesitas que lleven cambio o vuelto, la cantidad exacta. Cuando el vendedor esté conectado, te atenderá y coordinará contigo los detalles.";
  }
  if (/\b(moto|motos|motocicleta|motocicletas)\b/.test(normalized)) {
    return "Las motocicletas se anuncian por encargo y se gestionan a nombre del cliente. La modalidad, el costo y la fecha de entrega deben confirmarse directamente con el vendedor; no puedo prometer entrega a domicilio ni reservar una unidad desde este chat. Escríbele por WhatsApp: https://wa.me/5354590237.";
  }
  if (/\b(ecoflow|delta\s*\d|river\s*\d)\b/.test(normalized)) {
    return "La entrega a domicilio de las estaciones EcoFlow anunciadas es gratuita. La fecha y la hora se coordinan directamente con el vendedor según la disponibilidad y la carga del vehículo. Confirma el modelo y su publicación vigente antes de coordinar.";
  }
  if (/\b(estacion(?:es)?(?: de energia)?|energia portatil|bluetti)\b/.test(normalized)) {
    return "La entrega gratuita está confirmada para las estaciones EcoFlow anunciadas. Para la Bluetti Elite 100 V2 no tengo una modalidad de entrega confirmada; el vendedor debe indicarte si hay entrega, su costo y la fecha posible.";
  }
  if (/\b(telefono|telefonos|celular|celulares|movil|moviles|smartphone)\b/.test(normalized)) {
    return "La entrega a domicilio de los teléfonos es gratuita en Sagua la Grande, Isabela de Sagua, Cifuentes y Quemado. Se realiza mediante motorina eléctrica; el horario depende de la carga disponible y se coordina directamente con el vendedor.";
  }
  return "Si se trata de un teléfono, la entrega a domicilio es gratuita en Sagua la Grande, Isabela de Sagua, Cifuentes y Quemado. Se realiza mediante motorina eléctrica, según la carga disponible y previa coordinación con el vendedor. Las estaciones EcoFlow anunciadas también tienen entrega gratuita. Para otros productos, el costo y la modalidad deben confirmarse en su anuncio o directamente con el vendedor; no puedo fijar fechas ni horarios.";
}

/** Reuse the most recently named catalog model for elliptical follow-ups such as "¿y la entrega?" */
export function resolveRecentProductQuery(message: string, conversationThread: string): string {
  // An explicit category or model in the current question is a context boundary,
  // even when the customer phrases it as a follow-up ("and the stations' delivery?").
  const normalizedCurrent = normalizeStoreCatalogQuery(message);
  const isTechnicalFollowUp = isUniversalCatalogTechnicalQuestion(message);
  const namesDifferentProductCategory = /\b(nevera|refrigerador|refrigeradora|aire acondicionado|lavadora|televisor|laptop|computadora|tablet|bicicleta|generador|herramienta|electrodomestico)\b/i.test(normalizedCurrent);
  const namesKnownCategoryOutsideTechnicalFollowUp =
    !isTechnicalFollowUp && /\b(telefono|telefonos|celular|celulares|estacion(?:es)?|energia|ecoflow|bluetti|delta\s*\d|river\s*\d|moto|motos|motocicleta|motocicletas|izuki|isuki|xmx|huracan)\b/i.test(normalizedCurrent);
  if (isCatalogLookupQuestion(message) || hasProductReference(message) || namesDifferentProductCategory || namesKnownCategoryOutsideTechnicalFollowUp) return message;
  if (!conversationThread) return message;
  const customerMessages = [...conversationThread.matchAll(/Customer:\s*([^\n]+)/g)].map((match) => match[1]);
  for (const previous of customerMessages.reverse()) {
    // A newer category/catalog lookup is a context boundary too. Do not skip
    // it and accidentally revive an older phone model from earlier in the chat.
    if (isCatalogLookupQuestion(previous) || hasProductReference(previous) || isShortCatalogProductSelection(previous)) return previous;
  }
  return message;
}

export function hasProductReference(message: string): boolean {
  const candidate = normalizeStoreCatalogQuery(message).replace(/\b(?:4g|5g|\d+(?:gb|mb|ram|rom))\b/gi, " ");
  return /\b(?:[a-z]{1,8}\s*\d{1,4}[a-z0-9]*|\d{1,3}[a-z]{1,4}|izuki|isuki|xmx|huracan|ecoflow|bluetti|delta\s*\d|river\s*\d)\b/i.test(candidate);
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
    // Match the complete model token: A1 must never resolve to A16 or A160.
    const normalizedTitle = normalizeBusinessText(title);
    return modelIds.some((id) => new RegExp("(^|[^a-z0-9])" + id + "([^a-z0-9]|$)").test(normalizedTitle));
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
      return "La ficha de " + title + " indica entrega sin costo adicional. La modalidad, el lugar y la fecha de entrega deben confirmarse directamente con el vendedor antes de formalizar el encargo.";
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
  const normalized = normalizeStoreCatalogQuery(message);
  const hasModelCode = /\b(?:[a-z]{1,8}\s*\d{1,4}[a-z0-9]*|\d{1,3}[a-z]{1,4})\b/i.test(normalized)
    && !/\b\d+(?:gb|mb|ram|rom)\b/i.test(normalized);
  const asksInventory = /\b(telefonos?|celulares?|moviles?|smartphones?|ecoflow|estacion(?:es)? de energia|motocicletas?|motos?|productos?|equipos?|catalogo|que hay|que tienes|que tienen|que cosas tienes|que cosas tienen|que venden|que vendes|que cosas venden|que cosas vendes|que ofrecen|a la venta)\b/.test(normalized);
  const asksAvailability = /\b(tienes|tienen|hay|disponible|disponibilidad|en venta|venden|vendemos|queda|quedan|ofrecen|publicado|venta)\b/.test(normalized);
  const asksKnownBrand = /\b(ou?pes|ecoflow|bluetti|anker|jackery|allpowers|goal zero|samsung|galaxy|redmi|xiaomi|iphone|itel|tecno|infinix|motorola|honor|realme|oppo|vivo)\b/.test(normalized);
  const asksProductCategory = /\b(lamparas?|linternas?|bombillos?|focos?|ventiladores?|abanicos?|neveras?|refrigeradores?|lavadoras?|televisores?|laptops?|computadoras?|tabletas?|tablets?|bicicletas?|generadores?|herramientas?|ropa|zapatos?|relojes?|audifonos?|bocinas?|altavoces?|parlantes?|mochilas?|maletas?|muebles?|sillas?|mesas?|camas?|colchones?|cocinas?|hornillas?|microondas?|licuadoras?|cafeteras?|taladros?|paneles? solares?|inversores?|baterias? externas?|power banks?|accesorios?|limpieza|detergentes?|jabones?|perfumes?|cosmeticos?|maquillaje|juguetes?|alimentos?|comida|bebidas?|repuestos?|piezas?|neumaticos?|llantas?|aceites?|joyas?|bolsos?|carteras?|decoracion|cortinas?|sabanas?|toallas?)\b/.test(normalized);
  const asksTechnical = /\b(propiedades|caracteristicas|especificaciones|especificacion|potencia|cilindrada|cc|transmision|frenos|suspension|velocidad|combustible|capacidad|bateria|memoria|almacenamiento|ram|rom|procesador|pantalla|camara|conectividad|4g|5g|wh|lifepo4)\b/.test(normalized);
  const asksAccessory = /\b(cables?|cargador(?:es)?|adaptador(?:es)?|micas?|covers?|fundas?)\b/.test(normalized);
  const asksAccessoryCommerce = asksAccessory && /\b(tienes|tienen|hay|venden|vendes|vendemos|venta|precio|cuanto cuesta|cuanto valen|disponible|separado|sueltos?|sueltas?)\b/.test(normalized);
  const bareModel = /^(?:(?:un|una|el|la|ese|esa)\s+)?(?:(?:samsung|galaxy|redmi|xiaomi|iphone|itel|tecno|infinix|motorola|honor|realme|oppo|vivo)\s+)*(?:[a-z]{1,8}\s*\d{1,4}[a-z0-9]*|\d{1,3}[a-z]{1,4})[\s?!.]*$/i.test(normalized.trim());
  return (asksInventory && !asksTechnical)
    || (asksAvailability && asksKnownBrand && !asksTechnical)
    || (asksProductCategory && !asksTechnical)
    || asksAccessoryCommerce
    || (hasModelCode && (asksAvailability || bareModel));
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

  const normalized = normalizeStoreCatalogQuery(message);
  const isAccessoryQuery = /\b(cables?|cargador(?:es)?|adaptador(?:es)?|micas?|covers?|fundas?)\b/.test(normalized);
  const commerceIntent = /\b(tienes?|tienen|hay|vende(?:s|n|mos)?|venta|precio|cuanto cuesta|cuanto valen|disponible|separado|sueltos?|sueltas?)\b/.test(normalized);
  const asksCableOrCharger = /\b(cables?|cargador(?:es)?)\b/.test(normalized) && commerceIntent;
  const asksCoverOrScreenProtector = /\b(micas?|covers?|fundas?)\b/.test(normalized) && commerceIntent;
  const asksAdapter = /\badaptador(?:es)?\b/.test(normalized) && commerceIntent;
  // Route accessory commerce before parsing wattage/current tokens as model identifiers.
  if (asksCableOrCharger) {
    return "No vendemos cables ni cargadores por separado. Se incluyen con la compra de cualquiera de nuestros teléfonos, junto con cover de fábrica, mica protectora de cristal templado y 15 días de garantía.";
  }
  if (asksCoverOrScreenProtector) {
    return "El cover de fábrica y la mica protectora de cristal templado se incluyen con la compra de nuestros teléfonos. No tengo confirmación de que se vendan por separado; para evitar darte un dato incorrecto, consúltalo directamente con el vendedor.";
  }
  if (asksAdapter) {
    return "No tengo un anuncio confirmado de adaptadores disponibles por separado. Puedes consultar directamente con el vendedor para confirmar si tiene alguno.";
  }
  const blocks = context.flatMap((chunk) => chunk.text.split(/(?=PRODUCTO:\s*)/));
  const byTitle = new Map<string, { title: string; category: string; description: string; price: string; availability: string }>();
  for (const block of blocks) {
    const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim();
    if (!title) continue;
    const key = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const entry = byTitle.get(key) ?? { title, category: "", description: "", price: "", availability: "" };
    entry.category ||= block.match(/^Categor[ií]a:\s*(.+)$/im)?.[1]?.trim() ?? "";
    entry.description ||= block.match(/^(?:Descripción y características publicadas|Descripción):\s*(.+)$/im)?.[1]?.trim() ?? "";
    entry.price ||= block.match(/^Precio publicado:\s*(.+)$/im)?.[1]?.trim() ?? "";
    entry.availability ||= block.match(/^Disponibilidad publicada:\s*(.+)$/im)?.[1]?.trim() ?? "";
    byTitle.set(key, entry);
  }
  const products = [...byTitle.values()];
  if (products.length === 0) return null;

  const modelIds = [...normalized.matchAll(/\b([a-z]{1,8}\s*\d{1,4}[a-z0-9]*|\d{1,3}[a-z]{1,4})\b/g)]
    .map((match) => match[1].replace(/[^a-z0-9]/g, ""))
    .filter((key) => !/^\d+(?:gb|mb|ram|rom)$/.test(key));
  const requestedMoto = normalized.match(/\b(izuki|xmx|huracan)\b/)?.[1];
  if (requestedMoto) {
    const matches = products.filter((product) => {
      const title = normalizeBusinessText(product.title);
      return requestedMoto === "izuki"
        ? /\b(izuki|huracan)\b/.test(title)
        : requestedMoto === "huracan"
          ? /\b(izuki|huracan)\b/.test(title)
          : /\bxmx\b/.test(title);
    });
    if (matches.length === 1) {
      const product = matches[0];
      const status = product.availability ? " El anuncio indica: " + product.availability + "." : "";
      const price = product.price ? " El precio publicado es " + product.price + "." : "";
      return "Sí, " + product.title + " aparece en nuestro catálogo." + price + status + " Se gestiona por encargo a nombre del cliente. Para continuar, el vendedor debe confirmar las condiciones concretas del pedido por WhatsApp: https://wa.me/5354590237.";
    }
    return "No encuentro una publicación vigente que coincida con ese modelo de motocicleta. Puedes confirmarlo directamente con el vendedor: https://wa.me/5354590237.";
  }
  if (modelIds.length > 0) {
    const matches = products.filter((product) => {
      const title = product.title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      return modelIds.some((id) => new RegExp("(^|[^a-z0-9])" + id + "([^a-z0-9]|$)").test(title));
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
  const isEnergyQuery = /\bestacion(?:es)? de energia\b|\benergia portatil\b/.test(normalized);
  const isMotorcycleQuery = /\b(motocicletas?|motos?)\b/.test(normalized);
  const brandMatch = normalized.match(/\b(ou?pes|ecoflow|bluetti|anker|jackery|allpowers|goal zero|samsung|galaxy|redmi|xiaomi|iphone|itel|tecno|infinix|motorola|honor|realme|oppo|vivo)\b/);
  const requestedBrand = brandMatch?.[1] ?? "";
  const asksGalaxyS = /\b(galaxy|samsung)\b.*\bserie\s*s\b|\bserie\s*s\b.*\b(galaxy|samsung)\b|\bgalaxy\s+s\d*\b/.test(normalized);
  const hasProductCategory = /\b(lamparas?|linternas?|bombillos?|focos?|ventiladores?|abanicos?|neveras?|refrigeradores?|lavadoras?|televisores?|laptops?|computadoras?|tabletas?|tablets?|bicicletas?|generadores?|herramientas?|ropa|zapatos?|relojes?|audifonos?|bocinas?|altavoces?|parlantes?|mochilas?|maletas?|muebles?|sillas?|mesas?|camas?|colchones?|cocinas?|hornillas?|microondas?|licuadoras?|cafeteras?|taladros?|paneles? solares?|inversores?|baterias? externas?|power banks?|accesorios?|limpieza|detergentes?|jabones?|perfumes?|cosmeticos?|maquillaje|juguetes?|alimentos?|comida|bebidas?|repuestos?|piezas?|neumaticos?|llantas?|aceites?|joyas?|bolsos?|carteras?|decoracion|cortinas?|sabanas?|toallas?)\b/.test(normalized);
  const categoryTerms = normalized.split(/[^a-z0-9]+/).filter((term) =>
    term.length >= 4 && !/^(tienes?|tienen|tengo|hay|vendes?|venden|vendemos|quiero|busco|necesito|ofrecen|ofrecemos|precio|cuanto|cuesta|valen|disponible|disponibilidad|venta|publicado|publicada|recargable|recargables|electrica|electrico|portatil|portatiles|nueva|nuevo|usada|usado|que|cuales|cual|una|uno|unos|unas|los|las|del|para|con|por|en|de|el|la|un|me|interesa|interesan)$/.test(term)
  );
  let filtered = products;
  if (isPhoneQuery) {
    filtered = products.filter((product) => {
      const value = (product.title + " " + product.category).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      return /\b(telefonia|samsung|galaxy|redmi|xiaomi|iphone|itel|tecno|infinix|motorola|honor|realme|oppo|vivo)\b/.test(value);
    });
  } else if (asksGalaxyS) {
    filtered = products.filter((product) => /\b(galaxy\s+s\d*|samsung\s+s\d*)\b/i.test(normalizeBusinessText(product.title)));
  } else if (requestedBrand) {
    const brand = requestedBrand.toLowerCase();
    filtered = products.filter((product) => (product.title + " " + product.category)
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().includes(brand));
  } else if (isEnergyQuery) {
    filtered = products.filter((product) => /\bestacion(?:es)? de energia\b|\benergia\b/i.test(normalizeBusinessText(product.category + " " + product.title)));
  } else if (isMotorcycleQuery) {
    filtered = products.filter((product) => /\b(motocicleta|moto|izuki|xmx|huracan)\b/i.test(normalizeBusinessText(product.category + " " + product.title)));
  } else if (hasProductCategory) {
    const stem = (term: string) => term.length > 5 && term.endsWith("es") ? term.slice(0, -2) : term.length > 5 && term.endsWith("s") ? term.slice(0, -1) : term;
    filtered = products.filter((product) => {
      const value = normalizeBusinessText(product.title + " " + product.category + " " + product.description);
      const words = value.split(/[^a-z0-9]+/);
      return categoryTerms.length > 0 && categoryTerms.every((term) => {
        const singular = stem(term);
        return words.some((word) => word === term || word === singular || word.startsWith(singular));
      });
    });
  }
  if (filtered.length === 0) {
    const requestedPhrase = message.replace(/^[¿¡\s]*(?:tienes?|tienen|hay|vendes?|venden|vendemos|que|cuales|cual|me interesa|busco|quiero)\s+/i, "").replace(/[¿?¡!]/g, "").trim();
    const label = hasProductCategory ? "que coincidan con «" + requestedPhrase + "»" : asksGalaxyS ? "de la serie Galaxy S" : isPhoneQuery ? "de teléfonos" : requestedBrand ? "de la marca " + requestedBrand.toUpperCase() : isEnergyQuery ? "de estaciones de energía" : isMotorcycleQuery ? "de motocicletas" : "de productos";
    return "Ahora mismo no encuentro anuncios vigentes " + label + " en nuestro catálogo. El vendedor puede confirmar si hay alguna publicación nueva pendiente de sincronizar.";
  }
  const label = hasProductCategory ? "productos que coinciden con la búsqueda" : isPhoneQuery ? "teléfonos" : requestedBrand ? "productos " + requestedBrand.toUpperCase() : isEnergyQuery ? "estaciones de energía" : isMotorcycleQuery ? "motocicletas" : isAccessoryQuery ? "accesorios" : "productos";
  const lines = filtered.slice(0, 20).map((product) => {
    const details = [product.price, product.availability].filter(Boolean).join(" · ");
    return "• " + product.title + (details ? " — " + details : "");
  });
  const introduction = isEnergyQuery || isMotorcycleQuery ? "Estas son las " : "Estos son los ";
  return introduction + label + " que aparecen en nuestro catálogo publicado:\n" + lines.join("\n") + "\n\nLa disponibilidad física debe confirmarse directamente con el vendedor.";
}

/**
 * Answers payment questions directly from the approved store policy.
 * Never estimates exchange rates or implies CUP payment is accepted for USD ads.
 */
/** Answer identity questions about the assistant without inviting unrelated conversation. */
export function buildAssistantIdentityReply(message: string): string | null {
  const normalized = normalizeStoreCatalogQuery(message);
  const asksIdentity = /\b(eres una ia|eres ia|eres un robot|eres humano|quien eres|con quien hablo|hablo con una ia|hablo con un robot)\b/.test(normalized);
  if (!asksIdentity) return null;
  return "Sí, soy el asistente virtual de Cell Phone Store - Sagua la Grande. Soy una IA de apoyo comercial y puedo ayudarte con los productos publicados, sus precios, características verificadas, pagos y condiciones de compra. Si necesitas hablar directamente con el vendedor, puedes escribirle por WhatsApp: https://wa.me/5354590237.";
}

/** Resolve common ways customers ask for the store's public WhatsApp contact. */
export function buildBusinessContactReply(message: string): string | null {
  const normalized = normalizeStoreCatalogQuery(message);
  const asksContact = /\b(contacto|contactarlos|contactarlas|contactarme|contactar|comunicarme|comunicarse|whatsapp|escribirles|escribirle|hablar con el vendedor|hablar con ustedes|como los contacto|como puedo contactarlos|como puedo comunicarme|numero de contacto|telefono de contacto|telefono del vendedor|numero del vendedor|su numero|su telefono)\b/.test(normalized);
  if (!asksContact) return null;
  return "Puedes contactar directamente con el vendedor de Cell Phone Store - Sagua la Grande por WhatsApp: https://wa.me/5354590237. Por ese medio puedes consultar productos y coordinar una compra.";
}

export function buildPaymentPolicyReply(message: string): string | null {
  const normalized = normalizeStoreCatalogQuery(message);
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
  const asksUnconfirmedPayment = /\b(paypal|cripto(?:monedas)?|criptomonedas|bitcoin|btc|ethereum|eth|usdt|usdc|crypto)\b/.test(normalized);
  if (asksUnconfirmedPayment) {
    return "No tengo confirmación de que aceptemos ese método de pago. El método confirmado para los anuncios en USD es Zelle, con un recargo del 10%. Para consultar PayPal, criptomonedas u otra modalidad, debes confirmarlo directamente con el vendedor: https://wa.me/5354590237.";
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

function asksForZelleTotal(message: string): boolean {
  const normalized = normalizeBusinessText(message);
  return /\b(cuanto|cu[aá]l es el total|total|importe|monto|precio final|cuanto seria|cuanto queda|cuanto pago)\b/.test(normalized);
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

  const directPriceMatch = catalogReply.match(/\bprecio publicado es\s+([\d,.]+)\s*USD\b/i);
  // A brand/category lookup may return a one-item catalogue list instead of
  // the single-product sentence. Accept that format only when exactly one
  // USD price appears, so we never calculate a total for an ambiguous list.
  const listedPrices = [...catalogReply.matchAll(/(?:^|\n)\s*[•*-]?\s*[^\n]+?[—–-]\s*([\d,.]+)\s*USD\b/gm)];
  const priceText = directPriceMatch?.[1] ?? (listedPrices.length === 1 ? listedPrices[0][1] : null);
  if (!priceText) return null;
  const publishedPrice = Number(priceText.replace(/,/g, ""));
  if (!Number.isFinite(publishedPrice) || publishedPrice <= 0) return null;

  const total = Math.round(publishedPrice * 1.1 * 100) / 100;
  const formattedTotal = Number.isInteger(total) ? String(total) : total.toFixed(2);
  return catalogReply + " Con el recargo del 10% por Zelle, el total es " + formattedTotal + " USD.";
}

/**
 * Answers only stable, explicitly approved category policies. This path does
 * not confirm that a particular model is listed, available, or orderable.
 */
export function buildStorePolicyOnlyReply(message: string, productQuery = ""): string | null {
  const normalized = (message + " " + productQuery).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const asksConditions = /\b(incluye|incluyen|incluido|incluidos|trae|viene con|que trae|que incluye|accesorios|garantia|garantía|entrega|entregan|entregar|entregado|entregada|envio|envío|domicilio|prueba|devolucion|devolución|reparacion|reparación|encargo|encargar|encargue|pedido|proceso|pasos|funciona|vendo|vender|comprar|compra|cambio|cambiar|permuta|permuto|vuelto|tasar|tasacion)\b/.test(normalized);
  if (!asksConditions) return null;

  if (/\b(te vendo|vendo|quiero vender|les vendo|puedo vender|me lo compras|me compran|compras productos)\b/.test(normalized)) {
    return "Gracias por la oferta, pero la tienda no compra artículos a clientes. Solo comercializamos los productos publicados en nuestro catálogo.";
  }
  if (/\b(cambio|cambiar|permuta|permuto|vuelto|tasar|tasacion)\b/.test(normalized)) {
    return "Gracias por tu propuesta, pero no realizamos permutas, cambios ni tasaciones de artículos usados o nuevos, ni aceptamos productos como parte de pago.";
  }

  const asksWarranty = /\b(garantia|garantía|prueba|falla|fallo|responsabilidad|devolucion|devolución|reparacion|reparación)\b/.test(normalized);
  const asksEnergyCategory = /\b(estacion(?:es)? de energia|energia portatil)\b/.test(normalized);
  if (asksEnergyCategory && asksWarranty) {
    return "Las condiciones dependen del modelo. Las estaciones EcoFlow anunciadas por el negocio no tienen garantía comercial del vendedor y se prueban antes de la compra en presencia del comprador. Para la Bluetti Elite 100 V2, no tengo condiciones de garantía verificadas; pide al vendedor que confirme por escrito la cobertura y duración antes de comprar.";
  }

  if (/\b(ecoflow|delta\s*\d|river\s*\d)\b/.test(normalized)) {
    if (/\b(garantia|garantía|prueba|falla|fallo|responsabilidad|devolucion|devolución|reparacion|reparación)\b/.test(normalized)) {
      return "Las estaciones EcoFlow anunciadas por el negocio no tienen garantía comercial del vendedor. Antes de la compra, el equipo se prueba durante tiempo suficiente en presencia del comprador. Después de la entrega, el negocio no se responsabiliza por daños derivados de uso inadecuado o manipulación incorrecta. Para confirmar las condiciones del modelo concreto, consulta su anuncio o al vendedor.";
    }
    if (/\b(entrega|entregan|entregar|entregado|entregada|envio|envío|domicilio)\b/.test(normalized)) {
      return "La entrega a domicilio de las estaciones EcoFlow anunciadas es gratuita. La fecha y la hora se coordinan directamente con el vendedor según la disponibilidad y la carga del vehículo. La publicación vigente debe confirmar el modelo y su modalidad de venta.";
    }
    if (/\b(incluye|incluyen|incluido|incluidos|trae|viene con|que trae|que incluye|accesorios|bateria|batería|baterias|baterías)\b/.test(normalized)) {
      return "En las estaciones EcoFlow anunciadas, la compra incluye únicamente la caja y la unidad principal, salvo que el anuncio específico indique expresamente otra cosa. Las baterías de expansión se venden por separado y actualmente no hay baterías extra disponibles. No puedo confirmar desde esta consulta si ese modelo concreto está publicado; revisa el anuncio vigente o consúltalo con el vendedor.";
    }
  }

  if (/\b(moto|motos|motocicleta|motocicletas|izuki|isuki|xmx|huracan)\b/.test(normalized)) {
    const asksMotoWarranty = /\b(garantia|garantía|devolucion|devolución|reparacion|reparación)\b/.test(normalized);
    const asksMotoDelivery = /\b(entrega|entregan|entregar|entregado|entregada|envio|envío|domicilio)\b/.test(normalized);
    if (asksMotoWarranty && asksMotoDelivery) {
      return "Entrega: no tengo confirmada la modalidad de entrega de las motocicletas anunciadas por encargo. El vendedor debe confirmar si existe entrega a domicilio, su costo y la fecha posible antes de formalizar el pedido. Garantía: no tengo condiciones de garantía verificadas; antes de encargar, pide al vendedor que confirme por escrito la cobertura, duración y procedimiento aplicables al modelo concreto. Puedes consultarlo directamente por WhatsApp: https://wa.me/5354590237.";
    }
    if (asksMotoWarranty) {
      return "No tengo condiciones de garantía verificadas para las motocicletas anunciadas. Antes de encargar, pide al vendedor que confirme por escrito la cobertura, duración y procedimiento aplicables al modelo concreto.";
    }
    if (asksMotoDelivery) {
      return "No tengo confirmada la modalidad de entrega de las motocicletas anunciadas por encargo. El vendedor debe confirmar si existe entrega a domicilio, su costo y la fecha posible antes de formalizar el pedido.";
    }
    if (/\b(por encargo|encargar|encargo|pedido|proceso|pasos|incluye|incluyen|nueva|nuevo|como funciona|cómo funciona)\b/.test(normalized)) {
      return "El proceso consiste en solicitar la motocicleta anunciada por encargo a nombre del propio cliente. Antes de confirmar, el vendedor debe verificar el modelo, el precio y las condiciones concretas del pedido. No puedo confirmar ni formalizar una reserva, anticipo, plazo ni fecha de llegada; esos detalles debe confirmarlos directamente el vendedor por WhatsApp: https://wa.me/5354590237.";
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
 * Answers phone-specification questions from the exact current listing only.
 * It reports RAM/ROM or an explicit network-generation label, but never
 * infers 4G from the absence of 5G (or vice versa).
 */
export function buildPhoneTechnicalReply(
  message: string,
  productQuery: string,
  context: RetrievedChunk[],
  syncStatus: { stage?: string; updatedAt?: string } | null,
  now = Date.now(),
): string | null {
  const question = normalizeBusinessText(message);
  const asksTechnical = /\b(propiedades|caracteristicas|especificaciones|especificacion|4g|5g|conectividad|red movil|memoria|almacenamiento|ram|rom|procesador|pantalla|camara|bateria|carga|nfc|sistema operativo|resolucion|hz|potencia|cilindrada|cc|transmision|frenos|suspension|velocidad|combustible|capacidad|wh|kwh|lifepo4|quimica|expandible|ampliable|salida|entrada solar)\b/.test(question);
  if (!asksTechnical) return null;
  if (syncStatus?.stage !== "completed" || !syncStatus.updatedAt) return null;
  const syncedAt = Date.parse(syncStatus.updatedAt);
  const ageMs = now - syncedAt;
  if (!Number.isFinite(syncedAt) || ageMs < -5 * 60_000 || ageMs > 7 * 60 * 60_000) return null;

  const normalizedQuery = normalizeStoreCatalogQuery(productQuery);
  const modelIds = [...normalizedQuery.matchAll(/\b([a-z]{1,8}\s*\d{1,4}[a-z0-9]*|\d{1,3}[a-z]{1,4})\b/g)]
    .map((match) => match[1].replace(/[^a-z0-9]/g, ""))
    .filter((id) => !/^(?:4g|5g|\d+(?:gb|mb|ram|rom))$/.test(id));
  const requestedMoto = normalizedQuery.match(/\b(izuki|xmx|huracan)\b/)?.[1];
  const requestedEnergyBrand = normalizedQuery.match(/\b(ecoflow|bluetti)\b/)?.[1];
  if (modelIds.length === 0 && !requestedMoto && !requestedEnergyBrand) return null;

  const blocks = context.flatMap((chunk) => chunk.text.split(/(?=PRODUCTO:\s*)/));
  const matches = blocks.filter((block) => {
    const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1] ?? "";
    const normalizedTitle = normalizeBusinessText(title);
    const matchesModelCode = modelIds.some((id) => new RegExp("(^|[^a-z0-9])" + id + "([^a-z0-9]|$)").test(normalizedTitle));
    const matchesMoto = requestedMoto
      ? requestedMoto === "xmx" ? /\bxmx\b/.test(normalizedTitle) : /\b(izuki|huracan)\b/.test(normalizedTitle)
      : false;
    const matchesEnergyBrand = requestedEnergyBrand
      ? new RegExp("\\b" + requestedEnergyBrand + "\\b").test(normalizedTitle)
      : false;
    return matchesModelCode || matchesMoto || matchesEnergyBrand;
  });
  const unique = new Map<string, string>();
  for (const block of matches) {
    const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim();
    if (title) unique.set(normalizeBusinessText(title), block);
  }
  if (unique.size !== 1) return null;

  const block = [...unique.values()][0];
  const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim();
  if (!title) return null;
  const isMotorcycle = /\b(izuki|xmx|huracan|motocicleta|moto)\b/i.test(title);
  const isEnergyStation = /\b(ecoflow|bluetti|delta|river|estacion)\b/i.test(title);
  const isPhone = /\b(samsung|galaxy|redmi|xiaomi|iphone|itel|tecno|infinix|motorola|honor|realme|oppo|vivo)\b/i.test(title);
  if (!isMotorcycle && !isEnergyStation && !isPhone) return null;
  if (isMotorcycle) {
    const cc = title.match(/\b(\d{2,4})\s*cc\b/i)?.[1] ?? block.match(/^(?:Cilindrada|Motor):\s*(\d{2,4})\s*cc/im)?.[1];
    const labels = ["Motor", "Cilindrada", "Potencia", "Transmisión", "Frenos", "Suspensión", "Velocidad máxima", "Combustible"];
    const fields = labels.map((label) => {
      const value = block.match(new RegExp("^" + label + ":\\s*(.+)$", "im"))?.[1]?.trim();
      return value ? label + ": " + value : "";
    }).filter(Boolean);
    if (cc && !fields.some((field) => /Cilindrada|Motor/.test(field))) fields.unshift("Cilindrada: " + cc + " cc");
    if (fields.length === 0) {
      return "La ficha publicada de " + title + " no contiene especificaciones técnicas verificadas. Solo puedo confirmar lo que aparece en el anuncio; el vendedor debe facilitarte los datos del motor, potencia, transmisión y demás características antes del encargo.";
    }
    return "De " + title + ", la ficha publicada confirma: " + fields.join("; ") + ". No aparecen otras especificaciones verificadas en el anuncio. Para ampliar los detalles técnicos, puedes consultar al vendedor: https://wa.me/5354590237.";
  }

  if (isEnergyStation) {
    const titleCapacity = title.match(/\b(\d+(?:[.,]\d+)?)\s*(Wh|kWh)\b/i);
    const blockCapacity = block.match(/^(?:Capacidad(?: de (?:bateria|energia))?|Energia):\s*(\d+(?:[.,]\d+)?)\s*(Wh|kWh)$/im);
    const fields: string[] = [];
    const capacityValue = titleCapacity
      ? titleCapacity[1] + " " + titleCapacity[2]
      : blockCapacity
        ? blockCapacity[1] + " " + blockCapacity[2]
        : "";
    if (capacityValue) fields.push("Capacidad: " + capacityValue);
    const fieldPatterns: Array<[string, RegExp]> = [
      ["Potencia", /^(?:Potencia(?: de salida)?|Salida nominal):\s*(.+)$/im],
      ["Química de batería", /^(?:Quimica|Tipo de bateria):\s*(.+)$/im],
      ["Capacidad ampliable", /^(?:Capacidad ampliable|Expansion maxima|Ampliacion):\s*(.+)$/im],
      ["Entrada solar", /^(?:Entrada solar|Potencia solar maxima):\s*(.+)$/im],
      ["Voltaje", /^Voltaje:\s*(.+)$/im],
    ];
    for (const [label, pattern] of fieldPatterns) {
      const value = block.match(pattern)?.[1]?.trim();
      if (value && !fields.some((field) => field.startsWith(label + ":"))) fields.push(label + ": " + value);
    }
    const freeTextPower = block.match(/(?:potencia(?: de salida)?|salida nominal)[^\n.]{0,35}?(\d+(?:[.,]\d+)?\s*(?:W|kW))/i)?.[1];
    if (freeTextPower && !fields.some((field) => field.startsWith("Potencia:"))) fields.push("Potencia: " + freeTextPower.trim());
    const chemistry = block.match(/\b(LiFePO4|LFP|NMC)\b/i)?.[1];
    if (chemistry && !fields.some((field) => field.startsWith("Química de batería:"))) fields.push("Química de batería: " + chemistry);
    const expandable = block.match(/(?:ampliable|expandible|expansion)[^\n.]{0,45}?(\d+(?:[.,]\d+)?\s*(?:Wh|kWh))/i)?.[1];
    if (expandable && !fields.some((field) => field.startsWith("Capacidad ampliable:"))) fields.push("Capacidad ampliable: " + expandable.trim());
    if (fields.length === 0) {
      return "La ficha publicada de " + title + " no contiene especificaciones técnicas verificadas. Para evitar errores, el vendedor puede confirmarte la capacidad, potencia y demás características.";
    }
    return "De " + title + ", la ficha publicada confirma: " + fields.join("; ") + ". No aparecen otras especificaciones verificadas en el anuncio. Para ampliar los detalles técnicos, puedes consultar al vendedor: https://wa.me/5354590237.";
  }

  const ram = block.match(/\b(\d+)\s*GB\s*RAM\b/i)?.[1];
  const rom = block.match(/\b(\d+)\s*GB\s*ROM\b/i)?.[1];
  const network = block.match(/^(?:Conectividad|Redes? móviles?|Tecnología de red):\s*(.+)$/im)?.[1]?.trim()
    ?? title.match(/\b(4G|5G)\b/i)?.[1]?.toUpperCase();
  const asksNetwork = /\b(4g|5g|conectividad|red movil)\b/.test(question);
  const asksMemory = /\b(memoria|almacenamiento|ram|rom)\b/.test(question);
  const asksBroad = /\b(propiedades|caracteristicas|especificaciones|especificacion)\b/.test(question);
  const details: string[] = [];
  if ((asksMemory || asksBroad) && ram) details.push(ram + " GB de RAM");
  if ((asksMemory || asksBroad) && rom) details.push(rom + " GB de almacenamiento interno");
  if ((asksNetwork || asksBroad) && network) details.push("conectividad " + network);

  if (details.length === 0) {
    return asksNetwork
      ? "La ficha publicada de " + title + " no especifica si es 4G o 5G. Prefiero no darte un dato sin confirmar; el vendedor puede verificarlo."
      : "La ficha publicada de " + title + " no contiene suficientes especificaciones técnicas para responder con seguridad. El vendedor puede confirmarte esos detalles.";
  }
  const missingNetwork = asksNetwork && !network;
  const missingMemory = asksMemory && (!ram || !rom);
  let reply = "De " + title + ", la ficha publicada confirma " + details.join(" y ") + ".";
  if (missingNetwork) reply += " No especifica si es 4G o 5G.";
  if (missingMemory) reply += " No aparecen todos los datos de memoria en el anuncio.";
  if (asksBroad) reply += " El anuncio no incluye otras especificaciones, así que no quiero inventarlas.";
  return reply;
}

/**
 * Answers questions about the fixed bundle included with listed phones.
 * Requires both a matching product block and the pinned phone policy chunk.
 */
export function buildPhoneBundleReply(message: string, context: RetrievedChunk[], productQuery = message): string | null {
  const normalizedQuestion = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const normalizedProductQuery = productQuery.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const asksAboutBundle = /\b(incluye|incluyen|incluido|incluidos|trae|viene con|que trae|accesorios|garantia|dias de garantia)\b/.test(normalizedQuestion);
  if (!asksAboutBundle) return null;
  const phoneContext = /\b(telefono|telefonos|celular|celulares|movil|moviles|smartphone|smartphones|samsung|galaxy|redmi|xiaomi|iphone|itel|tecno|infinix|motorola|honor|realme|oppo|vivo|f07|a16|a17|a56)\b/.test(normalizedProductQuery);
  if (!phoneContext) return null;
  const modelIds = [...(normalizedQuestion + " " + normalizedProductQuery).matchAll(/\b[a-z]{1,6}\d{1,4}[a-z0-9]*\b/g)].map((match) => match[0]);
  if (modelIds.length === 0 || context.length === 0) return "La compra de cualquiera de nuestros teléfonos incluye cover de fábrica, mica protectora de cristal templado, cable USB y cargador original. Además, cuenta con 15 días de garantía.";
  const productBlocks = context.flatMap((chunk) => chunk.text.split(/(?=PRODUCTO:\s*)/));
  const matches = productBlocks.filter((block) => {
    const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1] ?? "";
    const normalizedTitle = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const isPhone = /\b(samsung|galaxy|redmi|xiaomi|iphone|itel|tecno|infinix|motorola|honor|realme|oppo|vivo)\b/.test(normalizedTitle);
    return isPhone && modelIds.some((modelId) => new RegExp("(^|[^a-z0-9])" + modelId + "([^a-z0-9]|$)").test(normalizedTitle));
  });
  if (matches.length !== 1) return null;
  const policy = STORE_POLICY.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!["cover de fabrica", "cable", "cargador", "mica protectora", "15 dias de garantia"].every((fact) => policy.includes(fact))) return null;
  const title = matches[0].match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim();
  if (!title) return null;
  return "La compra de " + title + " incluye cover de fábrica, mica protectora de cristal templado, cable USB y cargador original. Además, cuenta con 15 días de garantía.";
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
