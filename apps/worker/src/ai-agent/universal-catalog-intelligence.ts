/**
 * Product-agnostic technical answering for the Cell Phone Store catalog.
 * Listing text is the source of truth; no model/category-specific implementation is required.
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
  "producto", "productos", "equipo", "equipos", "modelo",
]);

function productBlocks(context: CatalogChunk[]): string[] {
  return context.flatMap((chunk) => chunk.text.split(/(?=PRODUCTO:\s*)/))
    .filter((block) => /^PRODUCTO:\s*.+/im.test(block));
}

function queryMatchesTitle(query: string, title: string): boolean {
  const q = normalize(query);
  const t = normalize(title);
  const ids = [...q.matchAll(/\b([a-z]{1,10}\s*\d{1,5}[a-z0-9]*|\d{1,4}[a-z]{1,5})\b/g)]
    .map((match) => match[1].trim());
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
    [/\b(\d+)\s*GB\s*RAM\b/i, "RAM"],
    [/\b(\d+)\s*GB\s*ROM\b/i, "Almacenamiento"],
    [/\b(\d+(?:[.,]\d+)?)\s*(kWh|Wh)\b/i, "Capacidad"],
    [/\b(\d+(?:[.,]\d+)?)\s*(kW|W)\b/i, "Potencia"],
    [/\b(\d{2,4})\s*cc\b/i, "Cilindrada"],
    [/\b(4G|5G)\b/i, "Red móvil"],
  ];
  for (const [pattern, label] of titlePatterns) {
    const match = title.match(pattern);
    if (match) facts.push(label + ": " + match[1] + (match[2] ? " " + match[2] : ""));
  }

  const ignored = /^(producto|categoria|precio publicado|condicion|disponibilidad publicada|vigencia de la publicacion hasta|entrega publicada|ficha publica|nota|contacto|whatsapp):/i;
  const allowedLabel = /^(?:capacidad(?: de bateria| de energia)?|potencia(?: de salida)?|salida nominal|entrada solar|quimica(?: de bateria)?|tipo de bateria|capacidad ampliable|expansion maxima|ampliacion|voltaje|motor|cilindrada|transmision|frenos|suspension|velocidad maxima|combustible|ram|rom|memoria|almacenamiento|pantalla|camara|bateria|conectividad|redes? moviles?|tecnologia de red|procesador|sistema operativo|material|dimensiones|peso|color|autonomia|resolucion|frecuencia|puertos?|conexiones?):/i;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-•*]\s*/, "");
    if (!line || ignored.test(line) || !allowedLabel.test(normalize(line))) continue;
    if (line.length <= 180 && !/https?:\/\/|\b\d{10,}\b|ignore|ignora|instruccion|system prompt/i.test(line)) {
      facts.push(line);
    }
  }

  const description = block.match(/^Descripción y características publicadas:\s*(.+)$/im)?.[1]?.trim();
  if (description) {
    const sentences = description.split(/(?<=[.!?])\s+/).filter((sentence) =>
      sentence.length <= 220 &&
      /\b(\d+(?:[.,]\d+)?\s?(?:gb|tb|mb|wh|kwh|w|kw|v|a|mah|cc|mp|hz|km\/h|km|pulgadas?)|lifepo4|nmc|bluetooth|wi-?fi|gps|abs|usb-c|5g|4g|solar|inverter|inversor|litio|diesel|gasolina|electrico|electrica)\b/i.test(normalize(sentence)) &&
      !/https?:\/\/|\b\d{10,}\b|ignore|ignora|instruccion|system prompt/i.test(sentence)
    );
    facts.push(...sentences.slice(0, 4));
  }
  return [...new Set(facts)].slice(0, 8);
}

export function isUniversalCatalogTechnicalQuestion(message: string): boolean {
  return /\b(consumo|amperaje|propiedades|caracteristicas|especificaciones|especificacion|detalles tecnicos|como es|que tiene|potencia|cilindrada|cc|transmision|frenos|suspension|velocidad|combustible|capacidad|bateria|memoria|almacenamiento|ram|rom|procesador|pantalla|camara|conectividad|4g|5g|wh|kwh|lifepo4|quimica|expandible|ampliable|salida|entrada solar|dimensiones|peso|material|autonomia|voltaje|motor)\b/.test(normalize(message));
}

export function buildUniversalCatalogTechnicalReply(
  message: string,
  productQuery: string,
  context: CatalogChunk[],
  syncStatus: SyncStatus,
  now = Date.now(),
  conversationThread = "",
): string | null {
  if (!isUniversalCatalogTechnicalQuestion(message)) return null;
  if (syncStatus?.stage !== "completed" || !syncStatus.updatedAt) return null;
  const syncedAt = Date.parse(syncStatus.updatedAt);
  const age = now - syncedAt;
  if (!Number.isFinite(syncedAt) || age < -5 * 60_000 || age > 7 * 60 * 60_000) return null;

  const blocks = productBlocks(context);
  const candidates = [
    productQuery,
    ...[...conversationThread.matchAll(/Customer:\s*([^\n]+)/g)].map((match) => match[1]).reverse(),
  ];
  let selected: string | null = null;
  for (const candidate of [...new Set(candidates)]) {
    const matches = blocks.filter((block) => {
      const title = block.match(/^PRODUCTO:\s*(.+)$/im)?.[1]?.trim() ?? "";
      return title && queryMatchesTitle(candidate, title);
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
