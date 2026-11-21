// Type contract for the AI support agent. The agent only depends on the
// bindings it actually touches (structural subset of the worker's Env), so
// it never imports from ../index and there's no import cycle.
export interface AgentEnv {
  AI: Ai;
  DB: D1Database;
  REPLY_CACHE: KVNamespace; // exact-answer + short-lived config cache
}

export interface AgentModels {
  /** Small model used for intent gating. */
  classifier: string;
  /** Main reply model — supports Workers AI function calling. */
  generator: string;
  /** Kept for compatibility with existing saved settings; D1 text retrieval does not use embeddings. */
  embedding: string;
}

export interface AgentConfig {
  workspaceId: string;
  enabled: boolean;
  businessName: string;
  /** Short description of what this business's support scope covers. */
  scopeDescription: string;
  replyInGroups: boolean;
  models: AgentModels;
  maxContextChunks: number;
  /** Legacy setting retained for compatibility; D1 text retrieval uses lexical matching. */
  similarityThreshold: number;
  cacheTtlSeconds: number;
  /** Optional custom system prompt instructions appended to the agent system prompt. */
  systemPrompt?: string;
}

export interface RetrievedChunk {
  id: string;
  text: string;
  score: number;
  source: string;
}

/** Internal schema of one function the model may call (Workers AI format). */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export interface ToolDefinition extends ToolSchema {
  handler: (args: Record<string, any>, ctx: AgentContext) => Promise<string>;
}

export interface AgentContext {
  env: AgentEnv;
  config: AgentConfig;
  workspaceId: string;
  /** D1 conversation id (present for WhatsApp-sourced messages). */
  conversationId?: string;
  /** Opaque WhatsApp-session id (used for conversation lookups). */
  waSessionId?: string;
  /** Resolved JID of the remote party (e.g. "1999...@s.whatsapp.net" or group JID). */
  remoteJid?: string;
  /** For group messages: the sender's JID (participant). For direct: same as remoteJid. */
  senderJid?: string;
  /** Bare digits of the customer's phone, used to scope personal data. */
  customerPhone?: string;
  isGroup: boolean;
}

export type IntentLabel = "SUPPORT" | "CODING" | "OFF_TOPIC" | "SENSITIVE";

export interface GuardrailResult {
  allowed: boolean;
  label: IntentLabel;
  cannedReply?: string;
}

export interface AgentReply {
  text: string;
  usedTools: string[];
  usedContext: RetrievedChunk[];
  blocked: boolean;
  blockReason?: IntentLabel;
  cached: boolean;
}

export interface AgentInput {
  message: string;
  conversationId?: string;
  waSessionId?: string;
  remoteJid?: string;
  senderJid?: string;
  customerPhone?: string;
  isGroup?: boolean;
}
