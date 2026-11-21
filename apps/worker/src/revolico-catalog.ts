import { ingestDocument } from "./ai-agent/rag";
import { loadAgentConfig } from "./ai-agent/config";
import type { Env } from "./index";

const SITE_ORIGIN = "https://revolico-sagua.pages.dev";
const BUSINESS_NAME = "Cell Phone Store - Sagua la Grande";
const OWNER_WHATSAPP_DIGITS = "5354590237";
const STATE_PREFIX = "revolico:catalog-sync:";
const CATALOG_DOC_ID = "revolico-sagua-public-catalog";
const BATCH_SIZE = 4;
const STATE_TTL_SECONDS = 6 * 3600;
const MAX_LISTINGS = 60;

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
  // The business name may be stored directly on agent_configs or inherited
  // from the workspace name by loadAgentConfig(). Match both representations
  // so a valid store workspace is not silently skipped when business_name is NULL.
  const workspaces = await env.DB.prepare(
    `SELECT agent_configs.workspace_id
     FROM agent_configs
     LEFT JOIN workspaces ON workspaces.id = agent_configs.workspace_id
     WHERE agent_configs.enabled = 1
       AND COALESCE(NULLIF(TRIM(agent_configs.business_name), ''), workspaces.name) = ?
     LIMIT 2`,
  ).bind(BUSINESS_NAME).all<{ workspace_id: string }>();

  for (const row of workspaces.results ?? []) {
    await syncWorkspaceCatalog(env, row.workspace_id);
  }
}

async function syncWorkspaceCatalog(env: Env, workspaceId: string): Promise<void> {
  const key = `${STATE_PREFIX}${workspaceId}`;
  let state = await env.REPLY_CACHE.get<SyncState>(key, "json");

  if (!isValidState(state)) {
    const response = await fetch(SITE_ORIGIN, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    if (!response.ok || new URL(response.url).origin !== SITE_ORIGIN) {
      throw new Error(`Revolico homepage unavailable (${response.status})`);
    }
    const html = await response.text();
    const urls = extractListingUrls(html).slice(0, MAX_LISTINGS);
    // An empty or unrecognizable homepage is not evidence that the seller's
    // catalog is empty. Keep the previous good catalog rather than deleting it.
    if (urls.length === 0) return;
    state = { urls, cursor: 0, records: [], startedAt: new Date().toISOString() };
  }

  const end = Math.min(state.cursor + BATCH_SIZE, state.urls.length);
  const batchUrls = state.urls.slice(state.cursor, end);
  const batch = await Promise.all(batchUrls.map((url) => fetchOwnedListing(url)));
  const records = [...state.records, ...batch.filter((item): item is PublicListing => item !== null).map(formatListing)];
  const next: SyncState = { ...state, cursor: end, records };

  if (end < state.urls.length) {
    await env.REPLY_CACHE.put(key, JSON.stringify(next), { expirationTtl: STATE_TTL_SECONDS });
    return;
  }

  // Only publish a complete scan. If any request fails, Promise.all rejects and
  // the old catalog remains intact; the next cron tick retries the same batch.
  const config = await loadAgentConfig(env, workspaceId);
  if (!config.enabled || config.businessName !== BUSINESS_NAME) {
    await env.REPLY_CACHE.delete(key);
    return;
  }

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
  ].join("\\n\\n");

  // Keep the project/page/app information indexed even when the seller has
  // no active listings. Re-ingestion replaces old listing chunks, so expired
  // or removed ads are not retained while the static project information stays.
  await ingestDocument(env, config, {
    source: "revolico-sagua.pages.dev (información oficial y anuncios públicos del vendedor 5354590237)",
    docId: CATALOG_DOC_ID,
    text,
    chunkSize: 1100,
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

/** Extract only same-origin listing detail links from the public homepage. */
export function extractListingUrls(html: string): string[] {
  const found = new Set<string>();
  const pattern = /href=["']([^"']*\/anuncio\/[0-9a-f-]{36})["']/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      const url = new URL(decodeEntities(match[1]), SITE_ORIGIN);
      if (url.origin === SITE_ORIGIN && /^\/anuncio\/[0-9a-f-]{36}$/i.test(url.pathname)) {
        found.add(url.toString());
      }
    } catch {
      // Ignore malformed or off-site links.
    }
  }
  return [...found];
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
  const description = extractElement(html, "div", "desc");
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

function extractElement(html: string, tag: string, className: string): string {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<${tag}\\b[^>]*class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripHtml(match[1]) : "";
}

function extractFact(html: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<p>\\s*<strong>\\s*${escaped}:?\\s*</strong>\\s*([\\s\\S]*?)<\\/p>`, "i"));
  return match ? stripHtml(match[1]) : "";
}

function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
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
