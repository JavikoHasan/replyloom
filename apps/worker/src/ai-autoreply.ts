// Bridges the generic AI agent to the WhatsApp inbound path. Kept out of
// whatsapp-session.ts so the session class stays focused on Baileys, and so
// the same agent can also be driven by the HTTP integration surface.
//
// Runs only when the workspace has opted in (agent_configs.enabled), honours
// the existing auto-reply access rules (blacklist/whitelist), and is hard-
// restricted to private one-to-one chats regardless of workspace settings.
// Keyword auto-reply rules run first (in whatsapp-session.ts) — this is the
// fallback when no canned rule matched.
import type { Env } from "./index";
import { createDb } from "@workspace/db";
import { isBlocked } from "./automation";
import { loadAgentConfig } from "./ai-agent/config";
import { handleAgentMessage } from "./ai-agent/agent";
import { scopedLogger } from "./logger";
import { isPrivateDirectChatJid } from "./session/message-routing";

export interface AiAutoReplyParams {
  waSessionId: string;
  workspaceId: string;
  conversationId: string;
  remoteJid: string;
  senderJid: string;
  isGroup: boolean;
  body: string;
}

// Anti-abuse: generous per-conversation cap to prevent runaway usage without
// interrupting normal customer conversations. Thirty messages in a fixed
// five-minute window allows rapid product follow-ups while retaining a burst
// limit. The counter lives in the SQLite Durable Object, not Workers KV.
const RATE_WINDOW_SECONDS = 300; // 5 minutes
const MAX_AGENT_INVOCATIONS_PER_WINDOW = 30;
const log = scopedLogger("ai-autoreply");

/** Returns the reply text to send, or null if the agent is off / should stay quiet. */
export async function maybeAiAutoReply(env: Env, params: AiAutoReplyParams): Promise<string | null> {
  const config = await loadAgentConfig(env, params.workspaceId);
  if (!config.enabled || config.businessName !== "Cell Phone Store - Sagua la Grande") return null;
  // This business assistant is private-chat-only. Never let a workspace
  // setting or an accidental caller enable replies in groups/channels.
  if (params.isGroup || !isPrivateDirectChatJid(params.remoteJid)) return null;

  const db = createDb(env.DB);
  if (await isBlocked(db, params.workspaceId, params.waSessionId, "auto_reply", params.senderJid)) return null;

  // Rate-limit BEFORE classifier/RAG/generation. Use the existing SQLite-backed
  // Durable Object limiter: a customer message must never consume a Workers KV
  // write just to increment a counter.
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`agent:${params.workspaceId}:${params.conversationId}`),
    );
    const keyHash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const shard = `rate-limiter:${keyHash.slice(0, 2)}`;
    const limiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(shard));
    const response = await limiter.fetch("https://rate-limit.internal/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyHash,
        limit: MAX_AGENT_INVOCATIONS_PER_WINDOW,
        windowMs: RATE_WINDOW_SECONDS * 1000,
      }),
    });
    if (!response.ok) throw new Error(`Agent rate limiter failed (${response.status})`);
    const result = await response.json();
    if (!result || typeof result !== "object" || !("success" in result) || result.success !== true) return null;
  } catch (err) {
    // Fail open if the limiter itself is unavailable; never silence a buyer
    // because an anti-abuse counter failed.
    log.warn({ err, workspaceId: params.workspaceId }, "Agent rate limiter unavailable; continuing without KV");
  }

  try {
    const reply = await handleAgentMessage(env, config, {
      message: params.body,
      conversationId: params.conversationId,
      waSessionId: params.waSessionId,
      remoteJid: params.remoteJid,
      senderJid: params.senderJid,
      isGroup: params.isGroup,
    });
    return reply.text || null;
  } catch (err) {
    // Workers AI Free has a daily neuron ceiling. If it is reached (or the
    // provider is temporarily unavailable), send a safe static response
    // instead of inventing stock, prices or delivery details.
    log.warn({ err, workspaceId: params.workspaceId }, "AI unavailable; using safe fallback reply");
    return `Soy el asistente virtual de ${config.businessName}. Ahora mismo no puedo verificar ese dato automáticamente y prefiero no darte información incorrecta. El vendedor podrá confirmártelo cuando esté disponible.`;
  }
}
