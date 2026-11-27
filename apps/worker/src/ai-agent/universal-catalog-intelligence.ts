/**
 * Product-agnostic technical answering for the Cell Phone Store catalog.
 * Listing text is the source of truth; no model/category-specific implementation is required.
 * This module is part of the isolated Cell Phone Store WhatsApp Worker release.
 * Deployment refresh: restore complete validated catalog selection guard.
 */
type CatalogChunk = { text: string };
type SyncStatus = { stage?: string; updatedAt?: string } | null;

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const STOP_WORDS = new Set([
  "un", "una", "el", "la", "los", "las", "ese", "esa", "este", "esta",
  "de", "del", "para", "por", "con", "que", "quiero", "interesa", "me",
  "tienes", "tienen", "hay", "dime", "sus", "caracteristicas", "propiedades",
  "especificaciones", "telefono", "telefonos", "celular", "celulares",
  "producto", "productos", "equipo", "equipos", "modelo", "tiene", "tienen", "es", "son", "como", "cual", "cuales", "cuanto", "cuanta", "del", "al", "su", "sus",
  "que", "y", "o", "potencia", "capacidad", "consumo", "propiedades", "caracteristicas", "especificaciones",
  "talla", "material", "color", "dimensiones", "medidas", "peso", "memoria", "almacenamiento", "procesador",
  "pantalla", "camara", "bateria", "conectividad", "red", "movil", "cilindrada", "velocidad", "frenos",
  "suspension", "autonomia", "voltaje", "quimica", "salida", "entrada", "tecnicas", "tecnicos",
]);

function productBlocks(context: CatalogChunk[]): string[] {
  return context.flatMap((chunk) => chunk.text.split(/(?=PRODUCTO:\s*)/))
    .filter((block) => /^PRODUCTO:\s*.+/im.test(block));
}

function queryMatchesTitle(query: string, title: string): boolean {
  const q = normalize(query);
  const t = normalize(title);
  // Network generations such as 4G/5G are technical attributes, not product
  // identifiers. Treating them as model codes can switch an elliptical follow-up
  // to an unrelated listing that happens to advertise the same network.
  const ids = [...q.matchAll(/\b([a-z]{1,10}\s*\d{1,5}[a-z0-9]*|\d{1,4}[a-z]{1,5})\b/g)]
    .map((match) => match[1].trim())
    .filter((id) => !/^[45]g$/i.test(id));
  if (ids.length) {
    return ids.some((id) =>
      new RegExp("(^|[^a-z0-9])" + id.replace(/\s+/g, "\\s*") + "([^a-z0-9]|$)").test(t)
    );
  }
  const tokens = q.split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  if (!tokens.length) return false;
  const matched = tokens.filter((word) => t.includes(word));
  return matched.length >= 2 || (tokens.length === 1 && tokens[0].length >= 5 && matched.length === 1);
}

function extractTechnicalFacts(block: string): string[] {
  const facts: string[] = [];
  const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1] ?? "";
  const titlePatterns: Array<[RegExp, string]> = [
    [/\b(\d+)\s*(GB)\s*RAM\b/i, "RAM"],
    [/\b(\d+)\s*(GB)\s*ROM\b/i, "Almacenamiento"],
    [/\b(\d+(?:[.,]\d+)?)\s*(kWh|Wh)\b/i, "Capacidad"],
    [/\b(\d+(?:[.,]\d+)?)\s*(kW|W)\b/i, "Potencia"],
    [/\b(\d{2,4})\s*(cc)\b/i, "Cilindrada"],
    [/\b(4G|5G)\b/i, "Red móvil"],
  ];
  for (const [pattern, label] of titlePatterns) {
    const match = title.match(pattern);
    if (match) facts.push(label + ": " + match[1] + (match[2] ? " " + match[2] : ""));
  }

  const ignored = /^(producto|categoria|precio publicado|condicion|disponibilidad publicada|vigencia de la publicacion hasta|entrega publicada|ficha publica|nota|contacto|whatsapp):/i;
  const allowedLabel = /^(?:capacidad(?: de bateria| de energia)?|potencia(?: de salida)?|salida nominal|entrada solar|carga solar|carga rapida|carga ultrarapida|control inteligente|ciclos? de carga|quimica(?: de bateria)?|tipo de bateria|capacidad ampliable|expansion maxima|ampliacion|voltaje|motor|cilindrada|transmision|frenos|suspension|velocidad maxima|combustible|ram|rom|memoria|almacenamiento|pantalla|camara|bateria|conectividad|redes? moviles?|tecnologia de red|procesador|sistema operativo|material|dimensiones|peso|color|talla|tejido|composicion|longitud|ancho|alto|profundidad|compatibilidad|impermeabilidad|resistencia|presion|temperatura|autonomia|resolucion|frecuencia|puertos?|conexiones?):/i;
  for (const rawLine of block.split(/\r?\n/)) {    const line = rawLine.trim().replace(/^[-•*]\s*/, "");    if (!line || ignored.test(line) || !allowedLabel.test(normalize(line))) continue;
    if (line.length <= 180 && !/https?:\/\/|\b\d{10,}\b|ignore|ignora|instruccion|system prompt/i.test(line)) {
      facts.push(line);
    }
  }

  const descriptionMarker = block.match(/^Descripción y características publicadas:\s*/im);
  const descriptionStart = descriptionMarker?.index;
  const descriptionMarkerLength = descriptionMarker?.[0].length ?? 0;
  const description = descriptionStart === undefined
    ? undefined
    : block.slice(descriptionStart + descriptionMarkerLength).split(/^Ficha pública:|^Nota:/im)[0].trim();
  if (description) {
    const sentences = description.split(/(?<=[.!?])\s+|\r?\n+/).map((sentence) => sentence.replace(/^[-•*]\s*/, "").trim()).filter((sentence) =>
      sentence.length <= 220 &&
      /\b(\d+(?:[.,]\d+)?\s?(?:gb|tb|mb|wh|kwh|w|kw|v|a|mah|cc|mp|hz|min(?:utos?)?|km\/h|km|pulgadas?)|lifepo4|nmc|bluetooth|wi-?fi|gps|abs|usb-c|5g|4g|solar|inverter|inversor|litio|diesel|gasolina|electrico|electrica)\b/i.test(normalize(sentence)) &&
      !/https?:\/\/|\b\d{10,}\b|ignore|ignora|instruccion|system prompt/i.test(sentence)
    );
    facts.push(...sentences.slice(0, 8));
  }
  return [...new Set(facts)].slice(0, 8);
}

export function isUniversalCatalogTechnicalQuestion(message: string): boolean {
  return /\b(consumo|amperaje|propiedades|caracteristicas|especificaciones|especificacion|detalles tecnicos|que tiene|potencia|cilindrada|cc|talla|tejido|composicion|medidas|longitud|ancho|alto|profundidad|color|temperatura|presion|compatibilidad|impermeabilidad|resistencia|transmision|frenos|suspension|velocidad|combustible|capacidad|bateria|memoria|almacenamiento|ram|rom|procesador|pantalla|camara|conectividad|4g|5g|wh|kwh|lifepo4|quimica|expandible|ampliable|salida|entrada solar|dimensiones|peso|material|autonomia|voltaje|motor)\b/.test(normalize(message));
}

export function buildUniversalCatalogTechnicalReply(
  message: string,
  productQuery: string,
  context: CatalogChunk[],
  syncStatus: SyncStatus,
  now = Date.now(),
): string | null {
  if (!isUniversalCatalogTechnicalQuestion(message)) return null;
  if (syncStatus?.stage !== "completed" || !syncStatus.updatedAt) return null;
  const syncedAt = Date.parse(syncStatus.updatedAt);
  const age = now - syncedAt;
  if (!Number.isFinite(syncedAt) || age < -5 * 60_000 || age > 7 * 60 * 60_000) return null;

  const blocks = productBlocks(context);
  // Prefer a product explicitly named in the current message. If the customer
  // asks only an elliptical follow-up, the resolved conversation query supplies
  // the active product. Matching is against listing titles, not a fixed brand list.
  const candidates = [...new Set([message, productQuery])];
  let selected: string | null = null;
  for (const candidate of candidates) {
    const candidateQuery = isShortCatalogProductSelection(candidate) ? selectionPhrase(candidate) : candidate;
    const matches = blocks.filter((block) => {
      const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim() ?? "";
      return title && queryMatchesTitle(candidateQuery, title);
    });
    const unique = new Map<string, string>();
    for (const block of matches) {
      const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim();
      if (title) unique.set(normalize(title), block);
    }
    if (unique.size === 1) {
      selected = [...unique.values()][0];
      break;
    }
    // A named product matching multiple listings is ambiguous. Do not silently
    // fall back to an older item from the conversation.
    if (unique.size > 1) return null;
  }
  if (!selected) return null;

  const block = selected;
  const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim();
  if (!title) return null;
  const facts = extractTechnicalFacts(block);
  const question = normalize(message);
  const asksNetwork = /\b(4g|5g|conectividad|red movil)\b/.test(question);
  const asksMemory = /\b(memoria|almacenamiento|ram|rom)\b/.test(question);
  if (!facts.length) {
    return "La ficha publicada de " + title + " no contiene características técnicas suficientes para responder con seguridad. Prefiero no inventar datos; el vendedor puede confirmarte las especificaciones.";
  }
  let reply = "De " + title + ", la información publicada confirma: " + facts.join("; ") + ".";
  if (asksNetwork && !facts.some((fact) => /4g|5g|red|conectividad/i.test(fact))) {
    reply += " El anuncio no especifica la conectividad de red.";
  }
  if (asksMemory && !facts.some((fact) => /ram|rom|memoria|almacenamiento/i.test(fact))) {
    reply += " El anuncio no especifica la memoria o el almacenamiento.";
  }
  reply += " No aparecen otras características verificadas en la ficha.";
  return reply;
}


const SELECTION_NOISE_WORDS = new Set([
  "para", "hoy", "manana", "pasado", "tarde", "noche", "temprano",
  "entrega", "entregar", "traer", "traigan", "llevar", "lleven", "envio",
  "domicilio", "urgente", "cuando", "cuanto", "por", "favor",
  "necesito", "necesitas", "pueden", "puede", "podrian",
  "encargo", "encargar", "pedido", "reservar", "reserva",
]);

const NON_PRODUCT_SELECTIONS = new Set([
  "momento", "pregunta", "segundo", "segundos", "favor", "rato", "poco", "minuto", "minutos",
  "garantia", "precio", "costo", "cuesta", "pago", "zelle", "cup", "entrega", "envio",
  "disponibilidad", "disponible", "reserva", "reservar", "incluye", "incluido", "funciona",
  "caracteristicas", "propiedades", "informacion", "ayuda", "gracias", "hola", "buenos",
  "buenas", "dias", "tardes", "noches",
]);

function selectionPhrase(message: string): string {
  return normalize(message)
    .replace(/[¿?¡!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:me interesa(?:ria)?|estoy interesado en|estoy interesada en|quiero|quisiera|me gustaria|me quedo con|me llevo|me gusta)\s+/, "")
    .replace(/^(?:un|una|el|la|ese|esa|este|esta)\s+/, "")
    .trim();
}

export function isShortCatalogProductSelection(message: string): boolean {
  const normalized = normalize(message).replace(/[¿?¡!.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  const phrase = selectionPhrase(message);
  const words = phrase.split(" ").filter(Boolean);
  const hasSelectionLead =
    /^(?:me interesa(?:ria)?|estoy interesado en|estoy interesada en|quiero|quisiera|me gustaria|me quedo con|me llevo|me gusta|un|una|el|la|los|las|ese|esa|este|esta)\s+/.test(normalized);
  const isStandaloneModel =
    /^(?:[a-z][a-z0-9-]*\s+){0,3}[a-z]{1,8}\s*\d{1,5}[a-z0-9]*$/.test(normalized);
  return words.length >= 1 && words.length <= 4 &&
    !words.some((word) => NON_PRODUCT_SELECTIONS.has(word)) &&    (hasSelectionLead || isStandaloneModel);
}
export function buildShortCatalogProductSelectionReply(
  message: string,
  context: CatalogChunk[],
  syncStatus: SyncStatus,
  now = Date.now(),
): string | null {
  if (!isShortCatalogProductSelection(message)) return null;
  if (syncStatus?.stage !== "completed" || !syncStatus.updatedAt) return null;
  const syncedAt = Date.parse(syncStatus.updatedAt);
  const age = now - syncedAt;
  if (!Number.isFinite(syncedAt) || age < -5 * 60_000 || age > 7 * 60 * 60_000) return null;

  const normalized = selectionPhrase(message);
  const terms = normalized.split(/\s+/).filter((term) => term.length >= 2 && !SELECTION_NOISE_WORDS.has(term));
  const matches = new Map<string, { title: string; price: string; availability: string }>();
  for (const block of productBlocks(context)) {
    const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim();
    if (!title) continue;
    const category = block.match(/^Categor[ií]a:\s*(.+)$/im)?.[1]?.trim() ?? "";
    const description = block.match(/^Descripción y características publicadas:\s*(.+)$/im)?.[1]?.trim() ?? "";
    const listingTokens = normalize(title + " " + category + " " + description).split(/[^a-z0-9]+/).filter(Boolean);
    const allTermsMatch = terms.length > 0 && terms.every((term) => {
      if (listingTokens.includes(term)) return true;
      if (term === "moto") return listingTokens.some((token) => token.startsWith("motociclet"));
      if (term === "telefono" || term === "celular") return listingTokens.some((token) => token === "telefonia" || token === "smartphone" || token === "smartphones");
      if (term === "nevera") return listingTokens.includes("refrigerador") || listingTokens.includes("refrigeradora");
      return false;
    });
    if (!allTermsMatch) continue;
    const key = normalize(title);
    matches.set(key, {
      title,
      price: block.match(/^Precio publicado:\s*(.+)$/im)?.[1]?.trim() ?? "",
      availability: block.match(/^Disponibilidad publicada:\s*(.+)$/im)?.[1]?.trim() ?? "",
    });
  }

  const products = [...matches.values()];
  if (products.length === 0) {
    return "No encuentro una publicación vigente que coincida con «" + normalized + "» en nuestro catálogo. Si me indicas el nombre o modelo exacto, puedo buscarlo.";
  }
  if (products.length > 1) {
    return "Encontré varios anuncios que podrían coincidir: " + products.slice(0, 5).map((item) => item.title).join("; ") + ". ¿Cuál de ellos te interesa?";
  }
  const product = products[0];
  const price = product.price ? " El precio publicado es " + product.price + "." : "";
  const status = product.availability ? " El anuncio indica: " + product.availability + "." : "";
  return "Sí, " + product.title + " aparece en nuestro catálogo." + price + status + " La existencia física debe confirmarse directamente con el vendedor.";
}