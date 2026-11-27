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

// No per-conversation AI invocation cap for this store: rapid customer
// follow-ups must not be silently dropped. The WhatsApp session still keeps
// its independent hourly anti-loop ceiling and outbound pacing protections.
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
