import { createDb, inArray, eq, and, docChunks } from "@workspace/db";
import type { AgentConfig, AgentEnv, RetrievedChunk } from "./types";

/**
 * Text-only retrieval keeps the agent's knowledge base on D1. It is not
 * semantic search: it matches meaningful words and ranks chunks by coverage.
 * Accents are normalized so Spanish questions match documents consistently.
 */
const STOP_WORDS = new Set([
  "a", "al", "algo", "como", "con", "cual", "cuando", "cuanto", "de", "del",
  "desde", "donde", "el", "ella", "en", "es", "esta", "este", "esto", "la",
  "las", "lo", "los", "mas", "me", "mi", "mis", "no", "o", "para", "pero",
  "por", "que", "se", "si", "sin", "su", "sus", "te", "tiene", "tienen",
  "un", "una", "uno", "unos", "unas", "y", "ya", "the", "a", "an", "and",
  "are", "do", "does", "for", "from", "how", "i", "in", "is", "it", "of",
  "on", "or", "please", "the", "to", "what", "when", "where", "which",
  "with", "you", "your",
]);

function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function queryTerms(query: string): string[] {
  return [...new Set(normalizeText(query).match(/[\p{L}\p{N}]{2,}/gu) ?? [])]
    .filter((term) => !STOP_WORDS.has(term))
    .slice(0, 8);
}

// SQLite GLOB character classes match common Spanish accented variants.
// lower() handles ordinary ASCII capitals; uppercase accented letters are
// included explicitly because SQLite's built-in lower() is ASCII-only.
function globFor(term: string): string {
  const variants: Record<string, string> = {
    a: "[aáÁ]", e: "[eéÉ]", i: "[iíÍ]", o: "[oóÓ]",
    u: "[uúÚüÜ]", n: "[nñÑ]",
  };
  return `*${[...term].map((char) => variants[char] ?? char).join("")}*`;
}

/**
 * Returns only chunks with meaningful overlap. A missing match remains an
 * empty context, so the caller's existing no-information branch prevents
 * the model from inventing prices, stock, delivery or other business facts.
 */
export async function retrieveContext(
  env: AgentEnv,
  config: AgentConfig,
  query: string,
): Promise<RetrievedChunk[]> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const predicates = terms.map(() => "lower(text) GLOB ?").join(" OR ");
  const statement = env.DB.prepare(
    `SELECT id, text, source FROM doc_chunks
     WHERE workspace_id = ? AND (${predicates})
     LIMIT 100`,
  ).bind(config.workspaceId, ...terms.map(globFor));

  const result = await statement.all<{ id: string; text: string; source: string }>();
  const normalizedQuery = normalizeText(query).trim();
  const ranked = (result.results ?? [])
    .map((row) => {
      const normalizedChunk = normalizeText(row.text);
      const matchedTerms = terms.filter((term) => normalizedChunk.includes(term)).length;
      const phraseMatch = normalizedQuery.length >= 4 && normalizedChunk.includes(normalizedQuery);
      const score = phraseMatch ? 1 : matchedTerms / terms.length;
      return { id: row.id, text: row.text, source: row.source, score };
    })
    // This is a lexical coverage score, not the old cosine similarity.
    .filter((chunk) => chunk.score >= 0.2)
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, Math.max(1, Math.min(config.maxContextChunks, 8)));
}

/**
 * Stores document chunks directly in D1. Re-ingesting a docId replaces its
 * previous chunks. No embedding model or Vectorize index is required.
 */
export async function ingestDocument(
  env: AgentEnv,
  config: AgentConfig,
  params: { source: string; text: string; docId?: string; chunkSize?: number },
): Promise<{ chunks: number; deleted?: number }> {
  const chunks = chunkText(params.text, params.chunkSize ?? 800);
  if (chunks.length === 0) return { chunks: 0 };

  const db = createDb(env.DB);
  let deleted = 0;
  if (params.docId) {
    const olds = await db
      .select({ id: docChunks.id })
      .from(docChunks)
      .where(and(eq(docChunks.workspaceId, config.workspaceId), eq(docChunks.docId, params.docId)))
      .all();
    if (olds.length > 0) {
      const oldIds = olds.map((row) => row.id);
      await db.delete(docChunks).where(inArray(docChunks.id, oldIds));
      deleted = oldIds.length;
    }
  }

  const inserts = chunks.map((text) => ({
    id: crypto.randomUUID(),
    workspaceId: config.workspaceId,
    docId: params.docId ?? null,
    source: params.source,
    text,
  }));
  const statements = inserts.map((chunk) => db.insert(docChunks).values(chunk));
  await db.batch(statements as unknown as [(typeof statements)[number], ...(typeof statements)[number][]]);

  return { chunks: inserts.length, deleted };
}

/**
 * Paragraph-aware chunking: packs paragraphs into chunks up to size instead
 * of cutting ordinary paragraphs mid-thought. Long paragraphs are hard-sliced.
 */
export function chunkText(text: string, size = 800): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  const paragraphs = cleaned.split(/\n\s*\n/).filter((paragraph) => paragraph.trim());
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const chunk = current.trim();
    if (chunk) chunks.push(chunk);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      if (current) flush();
      for (let i = 0; i < paragraph.length; i += size) {
        chunks.push(paragraph.slice(i, i + size).trim());
      }
      continue;
    }
    if (current.length > 0 && current.length + paragraph.length + 1 > size) flush();
    current = current ? `${current}\n${paragraph}` : paragraph;
  }
  flush();
  return chunks;
}
