import { ingestDocument } from "./ai-agent/rag";
import { loadAgentConfig } from "./ai-agent/config";
import type { Env } from "./index";

const SITE_ORIGIN = "https://revolico-sagua.pages.dev";
const BUSINESS_NAME = "Cell Phone Store - Sagua la Grande";
const OWNER_WHATSAPP_DIGITS = "5354590237";
const STATE_PREFIX = "revolico:catalog-sync:";
const CATALOG_DOC_ID = "revolico-sagua-public-catalog";
const BATCH_SIZE = 10;
const STATE_TTL_SECONDS = 6 * 3600;
const SYNC_COOLDOWN_SECONDS = 30 * 60;
const MAX_LISTINGS = 60;
const STATUS_KEY = `${STATE_PREFIX}status`;
const STATUS_REFRESH_INTERVAL_SECONDS = 30 * 60;
export interface CatalogSyncStatus {
  stage: string;
  message: string;
  updatedAt: string;
  workspaceId?: string;
  workspaceMatches?: number;
  discoveredUrls?: number;
  processedUrls?: number;
  acceptedListings?: number;
  chunks?: number;
}
export function shouldWriteCatalogStatus(
  current: CatalogSyncStatus | null,
  next: Omit<CatalogSyncStatus, "updatedAt">,
  now = Date.now(),
): boolean {
  if (!current) return true;
  const fields = [
    "stage", "message", "workspaceId", "workspaceMatches", "discoveredUrls",
    "processedUrls", "acceptedListings", "chunks",
  ] as const;
  const unchanged = fields.every((field) => current[field] === next[field]);
  if (!unchanged) return true;
  const lastUpdated = Date.parse(current.updatedAt);
  return !Number.isFinite(lastUpdated) ||
    now - lastUpdated >= STATUS_REFRESH_INTERVAL_SECONDS * 1000;
}

async function saveStatus(env: Env, status: Omit<CatalogSyncStatus, "updatedAt">): Promise<void> {
  // Cron runs every five minutes. Repeated identical errors (or a missing
  // workspace) must not generate 288 identical KV writes per day.
  const current = await getCatalogSyncStatus(env).catch(() => null);
  if (!shouldWriteCatalogStatus(current, status)) return;
  const next = { ...status, updatedAt: new Date().toISOString() } satisfies CatalogSyncStatus;
  try {
    await env.REPLY_CACHE.put(STATUS_KEY, JSON.stringify(next), { expirationTtl: 7 * 24 * 3600 });
  } catch (error) {
    // Status is diagnostic only: a KV quota error must never abort catalog
    // ingestion or the rest of the scheduled Worker tasks.
    console.warn("[revolico-catalog-sync] Unable to persist status:", error);
  }
}
export async function getCatalogSyncStatus(env: Env): Promise<CatalogSyncStatus | null> {
  return env.REPLY_CACHE.get<CatalogSyncStatus>(STATUS_KEY, "json");
}


interface SyncState {
  urls: string[];
  cursor: number;
  records: string[];
  startedAt: string;
}

export interface PublicListing {
  id: string;
  url: string;
  title: string;
  category: string;
  price: string;
  condition: string;
  description: string;
  status: "Disponible" | "Por encargo" | "Próximamente";
  expiresAt: string;
  delivery: string;
}

/**
 * One small batch per existing 5-minute cron tick. The public homepage is
 * read-only; detail pages are accepted only when their WhatsApp contact link
 * matches the store's exact number. No Supabase API or private DB is used.
 */
export async function syncRevolicoCatalog(env: Env): Promise<void> {
  try {
  // The business name may be stored directly on agent_configs or inherited
  // from the workspace name by loadAgentConfig(). Match both representations
  // so a valid store workspace is not silently skipped when business_name is NULL.
  // Resolve the dedicated store workspace from the organization table first.
  // agent_configs is intentionally optional (the agent starts disabled and may
  // not have been configured yet), so it must never be the driving table here.
  const workspaces = await env.DB.prepare(
    `SELECT organization.id AS workspace_id
     FROM organization
     LEFT JOIN agent_configs ON agent_configs.workspace_id = organization.id
     WHERE organization.name = ?
        OR NULLIF(TRIM(agent_configs.business_name), '') = ?
     LIMIT 2`,
  ).bind(BUSINESS_NAME, BUSINESS_NAME).all<{ workspace_id: string }>();

  if (workspaces.results.length === 0) {
    await saveStatus(env, { stage: "workspace_missing", message: "No se encontró el espacio de trabajo de Cell Phone Store.", workspaceMatches: 0 });
    console.warn("[revolico-catalog-sync] No matching Cell Phone Store workspace found; catalog sync skipped.");
    return;
  }

  console.info("[revolico-catalog-sync] Matching workspace(s) found:", workspaces.results.length);
  for (const row of workspaces.results) {
    await syncWorkspaceCatalog(env, row.workspace_id);
  }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : "Error desconocido";
    await saveStatus(env, { stage: "error", message: `Falló la sincronización: ${message}` }).catch(() => {});
    throw error;
  }
}

async function syncWorkspaceCatalog(env: Env, workspaceId: string): Promise<void> {
  const key = `${STATE_PREFIX}${workspaceId}`;
  const lastCompletedKey = `${STATE_PREFIX}last-completed:${workspaceId}`;
  const lastCompleted = Number(await env.REPLY_CACHE.get(lastCompletedKey));
  // A complete public-catalog scan is refreshed every 30 minutes. Without this
  // guard the 5-minute cron restarted the entire scan immediately after every
  // completion, needlessly writing progress/status keys all day.
  if (Number.isFinite(lastCompleted) && lastCompleted > 0 &&
      Date.now() - lastCompleted < SYNC_COOLDOWN_SECONDS * 1000) return;
  let state = await env.REPLY_CACHE.get<SyncState>(key, "json");

  if (!isValidState(state)) {
    // Avoid a stale edge-cached homepage and request the same HTML variant
    // a normal browser receives. The timestamp is a cache-busting query only;
    // it does not change or mutate the public Revolico site.
    const homepageUrl = new URL(SITE_ORIGIN);
    homepageUrl.searchParams.set("_catalog_sync", String(Date.now()));
    const response = await fetch(homepageUrl.toString(), {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok || new URL(response.url || homepageUrl.toString()).origin !== SITE_ORIGIN) {
      throw new Error(`Revolico homepage unavailable (${response.status})`);
    }
    const html = await response.text();
    const urls = extractListingUrls(html).slice(0, MAX_LISTINGS);
    const contentType = response.headers.get("content-type") ?? "desconocido";
    const hasListingMarkup = /\/anuncio\/[0-9a-f-]{36}/i.test(html) ||
      /data-supabase-id\s*=\s*["'][0-9a-f-]{36}["']/i.test(html);
    const diagnostic = `HTTP ${response.status}; ${contentType}; ${html.length} caracteres; marcado de anuncios: ${hasListingMarkup ? "sí" : "no"}`;
    console.info("[revolico-catalog-sync] Homepage fetched; listing links discovered:", urls.length);
    // An empty or unrecognizable homepage is not evidence that the seller's
    // catalog is empty. Keep the previous good catalog rather than deleting it.
    if (urls.length === 0) {
      console.warn("[revolico-catalog-sync] No listing detail URLs found on homepage; previous catalog preserved.");
      return;
    }
    state = { urls, cursor: 0, records: [], startedAt: new Date().toISOString() };
  }

  const end = Math.min(state.cursor + BATCH_SIZE, state.urls.length);
  const batchUrls = state.urls.slice(state.cursor, end);
  const batch = await Promise.all(batchUrls.map((url) => fetchOwnedListing(url)));
  const accepted = batch.filter((item): item is PublicListing => item !== null);
  const records = [...state.records, ...accepted.map(formatListing)];
  console.info("[revolico-catalog-sync] Listing batch processed:", {
    workspaceId,
    batchSize: batchUrls.length,
    accepted: accepted.length,
    rejectedOrNotOwned: batch.length - accepted.length,
    progress: `${end}/${state.urls.length}`,
  });
  if (state.cursor === 0) {
    await saveStatus(env, {
      stage: "reading_listings",
      workspaceId,
      message: "Leyendo y verificando las fichas públicas.",
      discoveredUrls: state.urls.length,
      processedUrls: 0,
      acceptedListings: 0,
    });
  }
  const next: SyncState = { ...state, cursor: end, records };

  if (end < state.urls.length) {
    await env.REPLY_CACHE.put(key, JSON.stringify(next), { expirationTtl: STATE_TTL_SECONDS });
    return;
  }

  // Only publish a complete scan. If any request fails, Promise.all rejects and
  // the old catalog remains intact; the next cron tick retries the same batch.
  const config = await loadAgentConfig(env, workspaceId);
  // Catalog synchronization is independent of the agent's enabled state.
  // Preload fresh public listings while the owner configures and tests the agent.
  const text = [
    `INFORMACIÓN DEL PROYECTO: REVOLICO SAGUA LA GRANDE es un proyecto local joven y en crecimiento para facilitar que las personas encuentren y publiquen anuncios. La página oficial es ${SITE_ORIGIN}. La aplicación oficial para Android se encuentra en ${SITE_ORIGIN}/download-apk. Los clientes pueden conocer el proyecto, visitar la página y compartirla voluntariamente con otras personas para ayudar a que llegue a más gente.`,
    `CATÁLOGO PÚBLICO DE ${BUSINESS_NAME}`,
    `Fuente: ${SITE_ORIGIN}`,
    `Sincronizado: ${new Date().toISOString()}`,
    "Estos datos proceden de las fichas públicas vigentes que enlazan exactamente al WhatsApp comercial 5354590237.",
    "La etiqueta Disponible es la indicada en el anuncio y NO garantiza existencia física: el vendedor debe confirmarla.",
    "Por encargo no significa entrega inmediata. Próximamente significa que el producto está en camino a Cuba y aún no ha llegado.",
    "Cuando la ficha indique entrega a domicilio sin costo adicional, la política de esta tienda es realizarla mediante motorina eléctrica, sin recargo. La hora depende de la carga disponible y se coordina directamente con el vendedor. El asistente nunca programa ni confirma una hora.",
    "No inventar datos ausentes.",
    ...records,
  ].join("\n\n");

  // Keep the project/page/app information indexed even when the seller has
  // no active listings. Re-ingestion replaces old listing chunks, so expired
  // or removed ads are not retained while the static project information stays.
  const ingested = await ingestDocument(env, config, {
    source: "revolico-sagua.pages.dev (información oficial y anuncios públicos del vendedor 5354590237)",
    docId: CATALOG_DOC_ID,
    text,
    chunkSize: 5000,
  });

  await saveStatus(env, { stage: "completed", message: "Catálogo guardado correctamente en Knowledge.", workspaceId, discoveredUrls: state.urls.length, processedUrls: end, acceptedListings: records.length, chunks: ingested.chunks });
  await env.REPLY_CACHE.put(lastCompletedKey, String(Date.now()), {
    expirationTtl: SYNC_COOLDOWN_SECONDS,
  });
  console.info("[revolico-catalog-sync] Catalog document ingested:", {
    workspaceId,
    documentId: CATALOG_DOC_ID,
    ownedListings: records.length,
    chunks: ingested.chunks,
    replacedChunks: ingested.deleted ?? 0,
  });
  await env.REPLY_CACHE.delete(key);
}

function isValidState(value: unknown): value is SyncState {
  if (!value || typeof value !== "object") return false;
  const state = value as SyncState;
  return Array.isArray(state.urls) && Array.isArray(state.records) &&
    Number.isInteger(state.cursor) && state.cursor >= 0 && state.cursor <= state.urls.length &&
    state.urls.every((url) => typeof url === "string" && isAllowedListingUrl(url));
}

/** Extract only same-origin listing detail links from the public homepage.
 * Accept both anchor hrefs and the stable IDs embedded in rendered listing cards.
 * The second path keeps catalog discovery working if the site's card markup changes.
 */
export function extractListingUrls(html: string): string[] {
  const found = new Set<string>();
  const addId = (rawId: string) => {
    const id = rawId.toLowerCase();
    // UUID shape is validated here; ownership and listing validity are checked
    // later against each public detail page and its exact WhatsApp number.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      found.add(SITE_ORIGIN + "/anuncio/" + id);
    }
  };

  // Parse route-shaped references directly from the HTML, including absolute
  // URLs, relative paths, JSON-LD, and escaped script fragments. Do not depend
  // on a particular anchor attribute order or quote style.
  for (const match of html.matchAll(/(?<![a-z0-9.-])(?:https?:\/\/revolico-sagua\.pages\.dev)?\/anuncio\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)) {
    addId(match[1]);
  }

  // Also accept stable IDs embedded on listing cards, even when no detail
  // anchor is present in the homepage HTML.
  for (const match of html.matchAll(/data-supabase-id\s*=\s*(["'])([0-9a-f-]{36})\1/gi)) {
    addId(match[2]);
  }
  for (const match of html.matchAll(/id\s*=\s*(["'])anuncio-publico-([0-9a-f-]{36})\1/gi)) {
    addId(match[2]);
  }

  return [...found].filter(isAllowedListingUrl);
}

function isAllowedListingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === SITE_ORIGIN && /^\/anuncio\/[0-9a-f-]{36}$/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function fetchOwnedListing(url: string): Promise<PublicListing | null> {
  if (!isAllowedListingUrl(url)) return null;
  const response = await fetch(url, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok || new URL(response.url).origin !== SITE_ORIGIN) {
    throw new Error(`Revolico listing fetch failed (${response.status})`);
  }
  return parseOwnedListingHtml(url, await response.text());
}

/** Pure parser kept separate so seller matching and expiry rules are testable. */
export function parseOwnedListingHtml(url: string, html: string, now = Date.now()): PublicListing | null {
  if (!isAllowedListingUrl(url)) return null;
  const contactLinks = [...html.matchAll(/href=["']https?:\/\/wa\.me\/(\d+)[^"']*["']/gi)];
  if (!contactLinks.some((match) => match[1] === OWNER_WHATSAPP_DIGITS)) return null;

  const title = extractElement(html, "h1", "h1");
  const category = extractElement(html, "div", "tag");
  const price = extractElement(html, "div", "price");
  const condition = extractElement(html, "div", "muted");
  const description = extractElement(html, "div", "desc", true);
  const availability = extractFact(html, "Disponibilidad indicada");
  const publishedState = extractFact(html, "Estado");
  const expires = extractFact(html, "Vigencia del anuncio hasta");
  const delivery = extractFact(html, "Entrega") || "No especificada en la ficha";
  const expiresAt = parseSpanishDate(expires);

  if (!title || !price || !description || !availability || !expiresAt) return null;
  if (!normalize(publishedState).includes("publicado y vigente")) return null;
  if (Date.parse(expiresAt) < now) return null;

  const statusText = normalize(availability);
  let status: PublicListing["status"];
  if (statusText === "disponible") status = "Disponible";
  else if (statusText === "por encargo") status = "Por encargo";
  else if (statusText === "proximamente") status = "Próximamente";
  else return null;

  const id = new URL(url).pathname.split("/").pop()!;
  return { id, url, title, category, price, condition, description, status, expiresAt: expires, delivery };
}

function extractElement(html: string, tag: string, className: string, preserveLines = false): string {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<${tag}\\b[^>]*class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? (preserveLines ? stripHtmlPreservingLines(match[1]) : stripHtml(match[1])) : "";
}

function extractFact(html: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<p>\\s*<strong>\\s*${escaped}:?\\s*</strong>\\s*([\\s\\S]*?)<\\/p>`, "i"));
  return match ? stripHtml(match[1]) : "";
}

function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
}

/** Preserve description paragraphs and list separators for technical extraction. */
function stripHtmlPreservingLines(value: string): string {
  const withBoundaries = value
    .replace(/<br\\s*\\/?\\s*>/gi, "\\n")
    .replace(/<\\/\\s*(?:p|div|li|h[1-6])\\s*>/gi, "\\n")
    .replace(/<li\\b[^>]*>/gi, "\\n- ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(withBoundaries)
    .replace(/\\r\\n?/g, "\\n")
    .replace(/[ \\t]+/g, " ")
    .replace(/\\s*·\\s*/g, "\\n- ")
    .replace(/ *\\n */g, "\\n")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();
}
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_all, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "nbsp") return " ";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    try { return Number.isFinite(code) ? String.fromCodePoint(code) : ""; } catch { return ""; }
  });
}

function parseSpanishDate(value: string): string | null {
  const match = normalize(value).match(/^(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) de (\d{4})$/);
  if (!match) return null;
  const months = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const date = new Date(Date.UTC(Number(match[3]), months.indexOf(match[2]), Number(match[1]) + 1, 5, 0, 0));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}


function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function formatListing(item: PublicListing): string {
  return [
    `PRODUCTO: ${item.title}`,
    `Categoría: ${item.category}`,
    `Precio publicado: ${item.price} (no convertir monedas)`,
    `Condición: ${item.condition}`,
    `Disponibilidad publicada: ${item.status}`,
    `Vigencia de la publicación hasta: ${item.expiresAt}`,
    `Entrega publicada: ${item.delivery}`,
    `Descripción y características publicadas: ${item.description}`,
    `Ficha pública: ${item.url}`,
    "Nota: confirmar existencia física con el vendedor; el asistente no puede confirmar ni programar entregas.",
  ].join("\n");
}
