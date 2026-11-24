/**
 * Conservative Spanish catalog-query typo normalization.
 *
 * Only known intent/category vocabulary is corrected. Product identifiers
 * containing digits are never fuzzy-matched, preventing A1 -> A16 mistakes.
 */
const VOCABULARY = [
  "tienes", "tienen", "hay", "venden", "vendemos", "venta", "disponible",
  "precio", "cuanto", "cuesta", "vale", "telefono", "telefonos", "celular", "celulares", "movil", "moviles",
  "smartphones", "estacion", "estaciones", "energia", "producto", "productos", "equipo", "equipos", "catalogo",
  "cable", "cables", "cargador", "cargadores", "adaptador", "adaptadores", "mica", "micas", "cover", "covers", "funda", "fundas",
  "separado", "sueltos", "sueltas", "oupes", "ecoflow", "bluetti",
  "anker", "jackery", "allpowers", "goal", "zero",
] as const;

function distanceAtMostTwo(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return false;
    previous = current;
  }
  return previous[b.length] <= limit;
}

function canonicalWord(word: string): string {
  if (!/^[a-z]+$/.test(word)) return word;
  if ((VOCABULARY as readonly string[]).includes(word)) return word;
  const candidates = VOCABULARY.filter((candidate) => {
    const length = Math.max(word.length, candidate.length);
    const limit = length >= 9 ? 2 : length >= 4 ? 1 : 0;
    return limit > 0 && distanceAtMostTwo(word, candidate, limit);
  });
  if (candidates.length !== 1) return word;
  return candidates[0];
}

export function normalizeStoreCatalogQuery(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase()
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .replace(/[a-z]+|[0-9]+|[^\\s]/g, (token) => canonicalWord(token))
    .replace(/\\s+/g, " ")
    .trim();
}

/** Deterministic typo/case variants used by the regression laboratory. */
export function generateCatalogQueryVariants(query: string): string[] {
  const variants = new Set<string>([
    query,
    query.toUpperCase(),
    query.toLowerCase(),
    query.replace(/á/gi, "a").replace(/é/gi, "e").replace(/í/gi, "i").replace(/ó/gi, "o").replace(/ú/gi, "u"),
    query.replace(/\\s+/g, "  "),
  ]);
  const substitutions: Array<[RegExp, string]> = [
    [/tienes/gi, "tines"], [/estaciones/gi, "estacones"],
    [/energía/gi, "enerjia"], [/cargador/gi, "cargdor"],
    [/teléfono/gi, "telefno"], [/celular/gi, "celualr"],
    [/precio/gi, "presio"], [/disponible/gi, "disponivle"],
    [/Oupes/gi, "Oups"],
  ];
  for (const [pattern, replacement] of substitutions) {
    if (pattern.test(query)) variants.add(query.replace(pattern, replacement));
  }
  return [...variants];
}
