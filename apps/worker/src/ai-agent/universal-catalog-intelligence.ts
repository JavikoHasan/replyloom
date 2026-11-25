/**
 * Product-agnostic technical answering for the Cell Phone Store catalog.
 * Listing text is the source of truth; no model/category-specific implementation is required.
 * This module is part of the isolated Cell Phone Store WhatsApp Worker release.
 * Deployment refresh: validated catalog-selection intent guard.
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
  const allowedLabel = /^(?:capacidad(?: de bateria| de energia)?|potencia(?: de salida)?|salida nominal|entrada solar|quimica(?: de bateria)?|tipo de bateria|capacidad ampliable|expansion maxima|ampliacion|voltaje|motor|cilindrada|transmision|frenos|suspension|velocidad maxima|combustible|ram|rom|memoria|almacenamiento|pantalla|camara|bateria|conectividad|redes? moviles?|tecnologia de red|procesador|sistema operativo|material|dimensiones|peso|color|talla|tejido|composicion|longitud|ancho|alto|profundidad|compatibilidad|impermeabilidad|resistencia|presion|temperatura|autonomia|resolucion|frecuencia|puertos?|conexiones?):/i;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-•*]\s