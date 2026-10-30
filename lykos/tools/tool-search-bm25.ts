// BM25 ranking for tool_search.
//
// Parameters k1 = 1.2 and b = 0.75 are the standard Okapi values, not a
// tuned choice, scored over a simple lowercase alphanumeric tokenizer.
//
// One combined search_text per tool: name, name with
// underscores replaced by spaces, description, then a recursive walk of
// the parameters schema adding each property name and each schema
// description. Empty parts are skipped; parts join with a space.

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export function searchTextForTool(tool: {
  name: string;
  description: string;
  parameters: unknown;
}): string {
  const parts: string[] = [];
  if (tool.name.length > 0) {
    parts.push(tool.name);
    const spaced = tool.name.replaceAll("_", " ");
    if (spaced !== tool.name) parts.push(spaced);
  }
  if (tool.description.length > 0) parts.push(tool.description);
  walkSchema(tool.parameters, parts);
  return parts.join(" ");
}

function walkSchema(schema: unknown, parts: string[]): void {
  if (schema === null || typeof schema !== "object") return;
  const rec = schema as Record<string, unknown>;
  if (typeof rec.description === "string" && rec.description.length > 0) {
    parts.push(rec.description);
  }
  if (rec.properties !== null && typeof rec.properties === "object") {
    for (const [key, value] of Object.entries(rec.properties as Record<string, unknown>)) {
      if (key.length > 0) parts.push(key);
      walkSchema(value, parts);
    }
  }
  if (Array.isArray(rec.items)) {
    for (const item of rec.items) walkSchema(item, parts);
  } else if (rec.items !== undefined) {
    walkSchema(rec.items, parts);
  }
  if (Array.isArray(rec.anyOf)) {
    for (const member of rec.anyOf) walkSchema(member, parts);
  }
  if (Array.isArray(rec.oneOf)) {
    for (const member of rec.oneOf) walkSchema(member, parts);
  }
  if (Array.isArray(rec.allOf)) {
    for (const member of rec.allOf) walkSchema(member, parts);
  }
  if (rec.additionalProperties !== null && typeof rec.additionalProperties === "object") {
    walkSchema(rec.additionalProperties, parts);
  }
}

interface IndexedDoc<T> {
  item: T;
  tf: Map<string, number>;
  length: number;
}

export function rankByBm25<T>(
  query: string,
  docs: readonly T[],
  textOf: (doc: T) => string,
): T[] {
  const tokens = tokenize(query);
  if (tokens.length === 0 || docs.length === 0) return [];

  const indexed: IndexedDoc<T>[] = docs.map((item) => {
    const tf = new Map<string, number>();
    const docTokens = tokenize(textOf(item));
    for (const term of docTokens) tf.set(term, (tf.get(term) ?? 0) + 1);
    return { item, tf, length: docTokens.length };
  });

  const n = indexed.length;
  const avgdl = indexed.reduce((sum, d) => sum + d.length, 0) / n;
  const df = new Map<string, number>();
  for (const doc of indexed) {
    for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const scored = indexed.map((doc) => {
    let score = 0;
    for (const term of tokens) {
      const f = doc.tf.get(term) ?? 0;
      if (f === 0) continue;
      const nqi = df.get(term) ?? 0;
      const idf = Math.log((n - nqi + 0.5) / (nqi + 0.5) + 1);
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgdl));
      score += idf * ((f * (BM25_K1 + 1)) / denom);
    }
    return { item: doc.item, score };
  });

  return scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);
}
