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

/**
 * Returns matching catalog chunks plus any explicitly pinned policy documents.
 * Pinned docs are scoped by workspace and docId, so generic business rules
 * remain available even when their wording does not overlap a product query.
 */
export async function retrieveContext(
  env: AgentEnv,
  config: AgentConfig,
  query: string,
  sourcePrefix?: string,
  includeDocIds: string[] = [],
): Promise<RetrievedChunk[]> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const normalizedTextSql = `replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(text), 'á','a'), 'Á','a'), 'é','e'), 'É','e'), 'í','i'), 'Í','i'), 'ó','o'), 'Ó','o'), 'ú','u'), 'Ú','u'), 'ü','u'), 'Ü','u'), 'ñ','n'), 'Ñ','n')`;
  const predicates = terms.map(() => `instr(${normalizedTextSql}, ?) > 0`).join(" OR ");
  const catalogMatch = sourcePrefix
    ? `(source LIKE ? AND (${predicates}))`
    : `(${predicates})`;
  const pinnedMatch = includeDocIds.length
    ? ` OR doc_id IN (${includeDocIds.map(() => "?").join(", ")})`
    : "";
  const statement = env.DB.prepare(
    `SELECT id, text, source, doc_id FROM doc_chunks
     WHERE workspace_id = ? AND (${catalogMatch}${pinnedMatch})
     LIMIT 100`,
  ).bind(
    config.workspaceId,
    ...(sourcePrefix ? [`${sourcePrefix}%`] : []),
    ...terms,
    ...includeDocIds,
  );

  const result = await statement.all<{ id: string; text: string; source: string; doc_id?: string | null }>();
  const normalizedQuery = normalizeText(query).trim();

  // When a customer names a specific model (F07, A07, DELTA 2, iPhone 13,
  // Redmi 14C, etc.), generic matches such as "Samsung" or "4GB" must never
  // crowd the requested product out of the small RAG context window. Keep only
  // chunks whose PRODUCTO heading contains that exact model identifier, plus
  // explicitly pinned policy docs. If no exact listing exists, fail closed:
  // do not let another model's listing be used to answer this question.
  const compactQuery = normalizedQuery.replace(/[^a-z0-9]/g, "");
  const modelKeys = [
    ...(compactQuery.match(/[a-z]{1,8}\d{1,4}[a-z0-9]*/g) ?? []),
    ...(compactQuery.match(/\d{1,3}[a-z]{1,4}/g) ?? []),
  ];
  const uniqueModelKeys = [...new Set(modelKeys)];
  let candidateRows = result.results;
  if (sourcePrefix && uniqueModelKeys.length > 0) {
    const exactProductRows = result.results.filter((row) =>
      row.text.split(/(?=PRODUCTO:\s*)/).some((block) => {
        const heading = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1] ?? "";
        const compactHeading = normalizeText(heading).replace(/[^a-z0-9]/g, "");
        return uniqueModelKeys.some((key) => compactHeading.includes(key));
      }),
    );
    if (exactProductRows.length === 0) return [];
    const pinnedRows = result.results.filter((row) => row.doc_id && includeDocIds.includes(row.doc_id));
    candidateRows = [...exactProductRows, ...pinnedRows.filter((row) => !exactProductRows.some((match) => match.id === row.id))];
  }

  const ranked = candidateRows
    .map((row) => {
      const normalizedChunk = normalizeText(row.text);
      const matchedTerms = terms.filter((term) => normalizedChunk.includes(term)).length;
      const phraseMatch = normalizedQuery.length >= 4 && normalizedChunk.includes(normalizedQuery);
      const isPinnedPolicy = Boolean(row.doc_id && includeDocIds.includes(row.doc_id));
      const heading = row.text.split(/(?=PRODUCTO:\s*)/).map((block) => block.match(/^PRODUCTO:\s*(.+)$/im)?.[1] ?? "").join(" ");
      const compactHeading = normalizeText(heading).replace(/[^a-z0-9]/g, "");
      const exactModelMatch = uniqueModelKeys.some((key) => compactHeading.includes(key));
      const score = isPinnedPolicy ? 1 : exactModelMatch ? 2 : phraseMatch ? 1 : matchedTerms / terms.length;
      return { id: row.id, text: row.text, source: row.source, score };
    })
    .filter((chunk) => chunk.score >= 0.2)
    .sort((a, b) => b.score - a.score);

  // Store catalog lookups can safely use the full supported context window;
  // the exact-model filter above keeps it focused instead of adding noise.
  const contextLimit = sourcePrefix ? 8 : config.maxContextChunks;
  return ranked.slice(0, Math.max(1, Math.min(contextLimit, 8)));
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
