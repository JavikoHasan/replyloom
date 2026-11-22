// Workspace-scoped text search over message history.
// This replaces per-message Workers AI embeddings and the paid Vectorize index.
import type { Env } from "./index";

const STOP_WORDS = new Set([
  "a", "al", "algo", "como", "con", "cual", "cuando", "cuanto", "de", "del",
  "desde", "donde", "el", "ella", "en", "es", "esta", "este", "esto", "la",
  "las", "lo", "los", "mas", "me", "mi", "mis", "no", "o", "para", "pero",
  "por", "que", "se", "si", "sin", "su", "sus", "te", "tiene", "tienen",
  "un", "una", "uno", "unos", "unas", "y", "ya", "the", "an", "and", "are",
  "do", "does", "for", "from", "how", "in", "is", "it", "of", "on", "or",
  "please", "to", "what", "when", "where", "which", "with", "you", "your",
]);

function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function queryTerms(query: string): string[] {
  return [...new Set(normalizeText(query).match(/[\p{L}\p{N}]{2,}/gu) ?? [])]
    .filter((term) => !STOP_WORDS.has(term))
    .slice(0, 8);
}


export function isWorthIndexing(text: string): boolean {
  return text.trim().length >= 12 && /[\p{L}\p{N}]/u.test(text);
}

/**
 * Kept as a compatibility no-op for the existing message-sync pipeline.
 * New messages are searchable directly from D1; no background embedding
 * request or per-message vector write is needed.
 */
export async function indexMessageForSearch(
  _env: Env,
  _params: {
    messageId: string;
    workspaceId: string;
    waSessionId: string;
    conversationId: string;
    text: string;
    isGroup?: boolean;
    groupName?: string | null;
    senderName?: string | null;
    senderJid?: string | null;
  },
): Promise<{ indexed: false }> {
  return { indexed: false };
}

/** Compatibility response for callers of the former bulk Vectorize reindex route. */
export async function indexMessagesForSearch(
  _env: Env,
  _workspaceId: string,
  _items: { messageId: string; waSessionId: string; conversationId: string; text: string }[],
): Promise<{ indexed: number }> {
  return { indexed: 0 };
}

export interface SearchMatch {
  messageId: string;
  score: number;
  conversationId: string;
  waSessionId: string;
  text: string;
  isGroup?: boolean;
  groupName?: string | null;
  senderName?: string | null;
  senderJid?: string | null;
}

/** Search the current workspace's stored messages by matching words in D1. */
export async function semanticSearch(
  env: Env,
  workspaceId: string,
  query: string,
  topK = 10,
): Promise<SearchMatch[]> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const normalizedBodySql = `replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(m.body), 'á','a'), 'Á','a'), 'é','e'), 'É','e'), 'í','i'), 'Í','i'), 'ó','o'), 'Ó','o'), 'ú','u'), 'Ú','u'), 'ü','u'), 'Ü','u'), 'ñ','n'), 'Ñ','n')`;
  const predicates = terms.map(() => `instr(${normalizedBodySql}, ?) > 0`).join(" OR ");
  const limit = Math.max(1, Math.min(Math.floor(topK), 20));
  const statement = env.DB.prepare(
    `SELECT m.wa_message_id AS messageId,
            m.conversation_id AS conversationId,
            c.wa_session_id AS waSessionId,
            m.body AS text,
            CASE WHEN c.kind = 'group' THEN 1 ELSE 0 END AS isGroup
       FROM messages AS m
       INNER JOIN conversations AS c ON c.id = m.conversation_id
      WHERE m.workspace_id = ?
        AND m.wa_message_id IS NOT NULL
        AND m.body IS NOT NULL
        AND m.deleted = 0
        AND (${predicates})
      ORDER BY m.created_at DESC
      LIMIT ?`,
  ).bind(workspaceId, ...terms, Math.min(limit * 8, 160));

  const result = await statement.all<{
    messageId: string;
    conversationId: string;
    waSessionId: string;
    text: string;
    isGroup: number;
  }>();

  const normalizedQuery = normalizeText(query).trim();
  return (result.results)
    .map((row) => {
      const normalizedBody = normalizeText(row.text);
      const matchedTerms = terms.filter((term) => normalizedBody.includes(term)).length;
      const phraseMatch = normalizedQuery.length >= 4 && normalizedBody.includes(normalizedQuery);
      const score = phraseMatch ? 1 : matchedTerms / terms.length;
      return {
        messageId: row.messageId,
        score,
        conversationId: row.conversationId,
        waSessionId: row.waSessionId,
        text: row.text,
        isGroup: row.isGroup === 1,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
