// Mistake-memory entries — parsing, rendering and types.
//
// The format rules live here because the maintainer's markdown files ARE the
// store. See `cli/memory.ts` for the CLI adapter; head assembly reads entries
// through `memory.ts`.

export type MemoryScope = "project" | "global";
export type MemoryFile = "gotchas" | "failed-approaches";

export const MEMORY_FILES: MemoryFile[] = ["gotchas", "failed-approaches"];
export const MEMORY_SCOPES: MemoryScope[] = ["project", "global"];

export function isMemoryScope(v: string): v is MemoryScope {
  return v === "project" || v === "global";
}
export function isMemoryFile(v: string): v is MemoryFile {
  return v === "gotchas" || v === "failed-approaches";
}

/** Keys this parser recognises. Anything else makes the group plain text. */
const META_KEYS = new Set([
  "added",
  "src",
  "paths",
  "invalid",
  "by",
  "reason",
  "seen",
  "first",
  "last",
  "target",
  // P10.6 (ticket 18, D7): `learn` attaches the exchange that produced the
  // correction. It is a new KEY in this format, never a second format — D3
  // says the proposal and its provenance live in the markdown store the
  // project already has, and one more recognised key is the smallest thing
  // that fits. Appended last in `renderEntryMeta` too, so every line written
  // before today still renders byte-identically.
  "from",
]);

export interface MemoryMeta {
  /** ISO date the entry was added. */
  added?: string;
  /** Session that produced the lesson. Provenance, so a bad memory is traceable. */
  src?: string;
  /** Paths the claim depends on. T79 treats a missing one as staleness. */
  paths?: string[];
  /** ISO date this entry was superseded. Set => never injected (T78). */
  invalid?: string;
  /** Session that superseded it. */
  by?: string;
  /** Why. Free text, quoted in the file. */
  reason?: string;
  /** T81 (proposals only): independent times this lesson has been proposed. */
  seen?: string;
  /** T81: first and last time it was proposed. */
  first?: string;
  last?: string;
  /** T81: the file it would be accepted into. */
  target?: string;
  /**
   * P10.6 (D7): the exchange `learn` was given, flattened to one line. This
   * is provenance a human reads when deciding whether to accept — "what did
   * the model think it was corrected about" — and it survives acceptance,
   * because a memory whose origin is gone is a memory nobody can audit.
   */
  from?: string;
}

export interface MemoryEntry {
  id: string;
  /** The lesson itself, metadata stripped. This is what gets injected. */
  text: string;
  lineIndex: number;
  meta: MemoryMeta;
}

const ENTRY_RE = /^- \[([0-9a-f]{8})\] (.*)$/;
const META_RE = /^(.*?)\s*\{([^{}]*)\}\s*$/;

/**
 * Split `k=v k="v with spaces"` into pairs. Returns undefined the moment
 * anything does not fit -- an unknown key, a bare word, an unterminated
 * quote -- which is what sends the whole group back to being text.
 */
function parseMetaBody(body: string): MemoryMeta | undefined {
  if (body.trim().length === 0) return undefined;
  const meta: MemoryMeta = {};
  const re = /([a-z]+)=("(?:[^"\\]|\\.)*"|[^\s]+)/gy;
  let consumed = 0;
  re.lastIndex = 0;
  while (re.lastIndex < body.length) {
    while (re.lastIndex < body.length && /\s/.test(body[re.lastIndex]!)) re.lastIndex += 1;
    if (re.lastIndex >= body.length) break;
    const m = re.exec(body);
    if (m === null) return undefined;
    const key = m[1]!;
    if (!META_KEYS.has(key)) return undefined;
    let value = m[2]!;
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    if (key === "paths") {
      meta.paths = value
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0);
    } else {
      (meta as Record<string, unknown>)[key] = value;
    }
    consumed = re.lastIndex;
  }
  if (consumed !== body.length && body.slice(consumed).trim().length > 0) return undefined;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** Split one entry body into its lesson text and its metadata, if any. */
export function splitEntryMeta(body: string): { text: string; meta: MemoryMeta } {
  const m = META_RE.exec(body);
  if (m === null) return { text: body, meta: {} };
  const meta = parseMetaBody(m[2]!);
  if (meta === undefined) return { text: body, meta: {} };
  return { text: m[1]!, meta };
}

/** Render metadata back to the trailing brace group. "" when there is none. */
export function renderEntryMeta(meta: MemoryMeta): string {
  const parts: string[] = [];
  const quote = (v: string): string =>
    /[\s"{}]/.test(v) ? `"${v.replace(/(["\\])/g, "\\$1")}"` : v;
  if (meta.added) parts.push(`added=${quote(meta.added)}`);
  if (meta.src) parts.push(`src=${quote(meta.src)}`);
  if (meta.paths && meta.paths.length > 0) parts.push(`paths=${quote(meta.paths.join(","))}`);
  if (meta.invalid) parts.push(`invalid=${quote(meta.invalid)}`);
  if (meta.by) parts.push(`by=${quote(meta.by)}`);
  if (meta.reason) parts.push(`reason=${quote(meta.reason)}`);
  if (meta.seen) parts.push(`seen=${quote(meta.seen)}`);
  if (meta.first) parts.push(`first=${quote(meta.first)}`);
  if (meta.last) parts.push(`last=${quote(meta.last)}`);
  if (meta.target) parts.push(`target=${quote(meta.target)}`);
  // Last, deliberately: every line this project has ever written predates
  // `from`, and appending keeps their rendering unchanged.
  if (meta.from) parts.push(`from=${quote(meta.from)}`);
  return parts.length === 0 ? "" : ` {${parts.join(" ")}}`;
}

/** The full markdown line for an entry. The inverse of `parseMemoryEntries`. */
export function renderMemoryEntry(id: string, text: string, meta: MemoryMeta): string {
  return `- [${id}] ${text}${renderEntryMeta(meta)}`;
}

/** Parses every `- [id] text` line. Any other line (the header, prose) is not an entry. */
export function parseMemoryEntries(raw: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = ENTRY_RE.exec(lines[i]!);
    if (!m) continue;
    const { text, meta } = splitEntryMeta(m[2]!);
    entries.push({ id: m[1]!, text, lineIndex: i, meta });
  }
  return entries;
}

/** An entry is a live memory unless it has been superseded. T78/T79 both read this. */
export function isEntryValid(entry: MemoryEntry): boolean {
  return entry.meta.invalid === undefined;
}
