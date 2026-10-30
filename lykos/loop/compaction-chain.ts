// P17 T190 -- a chain of compaction methods.
//
// An ordered list of compaction methods, each tried until one works. Lykos's
// chain has four methods and this is the pure half: their names, the
// order's validation, and the runner that walks the order and keeps, for the
// ledger, which method ran and why each one before it fell through.
//
//   note      the agent's own note (`self_compact`, today's path): the
//             compaction a pending note asked for, summarised by Pi
//   handoff   a side call with no tools that writes the note from the
//             template when Pi compacts and the agent left none
//   shake     drops tool results the agent can run again, in place, with no
//             model call
//   summary   Pi's own summary: the last resort, and what runs when the others
//             do not
//
// **Pi's summary is always the end of the chain.** A method list that leaves it
// out still ends there, because a compaction that no method took has to be
// done by someone, and Pi's summariser is the one that exists. An empty list
// therefore means "Pi's summary only", which is what Lykos did before T190.
//
// **Unknown names are ignored**, not refused (the ticket's rule): a name from a
// newer or older Lykos must not stop a session. `parseMethodOrder` returns what
// it ignored so boot can say so on stderr -- a typo that quietly drops a
// method is the failure the tier table's validation exists to prevent.

/** The methods, in the default order. */
export const COMPACTION_METHODS = ["note", "handoff", "shake", "summary"] as const;

export type CompactionMethod = (typeof COMPACTION_METHODS)[number];

/** `compaction.method_order`'s default (spec #15, "Gap 2 chain"). */
export const DEFAULT_METHOD_ORDER: readonly CompactionMethod[] = COMPACTION_METHODS;

export function isCompactionMethod(value: unknown): value is CompactionMethod {
  return typeof value === "string" && (COMPACTION_METHODS as readonly string[]).includes(value);
}

/**
 * The order as configuration wrote it, validated: known names, first mention
 * wins, case and surrounding space ignored. Absent (`undefined`) is the
 * default; present but empty is Pi's summary alone. `ignored` lists what was
 * dropped (an unknown name, a repeat, a value that is not text), for the notice.
 */
export function parseMethodOrder(raw: unknown): { order: CompactionMethod[]; ignored: string[] } {
  if (raw === undefined || raw === null) return { order: [...DEFAULT_METHOD_ORDER], ignored: [] };
  if (!Array.isArray(raw)) return { order: [...DEFAULT_METHOD_ORDER], ignored: [String(raw)] };
  const order: CompactionMethod[] = [];
  const ignored: string[] = [];
  for (const item of raw) {
    const name = typeof item === "string" ? item.trim().toLowerCase() : undefined;
    if (name !== undefined && isCompactionMethod(name) && !order.includes(name)) order.push(name);
    else ignored.push(typeof item === "string" ? item : JSON.stringify(item) ?? String(item));
  }
  return { order, ignored };
}

/** A method that did not do the compaction, and the reason it gave. */
export interface FellThrough {
  method: CompactionMethod;
  reason: string;
  /** A method that made a model call before it fell through still cost something; the call's usage, as the provider reported it. */
  usage?: CompactionUsage;
}

/**
 * What a compaction's own model call used, as the provider reported it and as
 * the `calls` row keeps it: cache read, cache write and the part of the write
 * that was a one-hour write (priced differently, findings 1.3) apart. 0 for
 * shake, which makes no call; null when the provider reported none (Pi's
 * summariser sometimes does not; only Anthropic reports the one-hour split).
 */
export interface CompactionUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  cache_write_1h_tokens?: number | null;
}

/** What one method says: it ran (with whatever it produced), or why it did not. */
export type MethodResult<T> = { ran: T } | { fell: string; usage?: CompactionUsage };

/** The runnable methods, by name. `summary` is not here: it is the end of the chain, not a step. */
export type ChainSteps<T> = Partial<Record<Exclude<CompactionMethod, "summary">, () => Promise<MethodResult<T>>>>;

export interface ChainOutcome<T> {
  /** The method that ran; `summary` when none before it did. */
  method: CompactionMethod;
  /** What that method produced; undefined for `summary`, which Pi does itself. */
  value?: T;
  /** Every method tried before it, in order, with why each fell through. */
  tried: FellThrough[];
}

/**
 * Walks `order`. A step that returns `{ fell }`, or throws, falls through to
 * the next; a method named in `order` with no step is skipped without a line
 * (the caller has nothing to offer for it). Listing `summary` ends the walk
 * there. `aborted` is asked before each step: an aborted
 * compaction must not go on to try the rest.
 */
export async function runChain<T>(
  order: readonly CompactionMethod[],
  steps: ChainSteps<T>,
  aborted: () => boolean = () => false,
): Promise<ChainOutcome<T>> {
  const tried: FellThrough[] = [];
  for (const method of order) {
    if (method === "summary") break;
    const step = steps[method];
    if (step === undefined) continue;
    if (aborted()) break;
    try {
      const result = await step();
      if ("ran" in result) return { method, value: result.ran, tried };
      tried.push({ method, reason: result.fell, ...(result.usage !== undefined ? { usage: result.usage } : {}) });
    } catch (error) {
      tried.push({ method, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { method: "summary", tried };
}

// P17 T191 (spec #15) -- `/compact <method>` overrides the chain for one run.
//
// A table of modes, one parser, and a first token that is not a mode keeps its
// old meaning as focus text. Lykos's table has the two chain methods a person can ask for by name.
// `note` is the agent's own and `summary` is the end of the chain every run
// has; neither is a mode, and naming them in `/compact` stays focus text. Pi
// hands a manual compaction's whole argument string to its own summariser as
// the focus, and an extension cannot rewrite it, so a `summary` mode would send
// the word "summary" to the summariser as its instruction.
//
// **How a name is told from focus text.** Only the first whitespace-separated
// token is looked at, case-insensitively and whole: `/compact shake` is the
// method, `/compact handoff keep X` is the method with the focus "keep X" (an
// error, for a method that takes none), and `/compact shaker` or `/compact
// then shake` is focus text. Someone whose focus text genuinely begins with
// "shake" or "handoff" writes another word first.

/** What a manual `/compact` argument asks for. */
export type CompactArgs = { method?: CompactionMethod; focus?: string } | { error: string };

interface CompactMode {
  readonly method: Exclude<CompactionMethod, "note" | "summary">;
  /** False for a method that makes no model call: focus text has nothing to steer. */
  readonly takesFocus: boolean;
}

const COMPACT_MODES: readonly CompactMode[] = [
  { method: "handoff", takesFocus: true },
  { method: "shake", takesFocus: false },
];

/** The method names `/compact` offers as its first argument. */
export const COMPACT_MODE_NAMES: readonly string[] = COMPACT_MODES.map((m) => m.method);

/** Splits `/compact`'s argument into an optional method and optional focus text. */
export function parseCompactArgs(args: string | undefined): CompactArgs {
  const text = (args ?? "").trim();
  if (text.length === 0) return {};
  const space = text.search(/\s/);
  const first = space === -1 ? text : text.slice(0, space);
  const mode = COMPACT_MODES.find((m) => m.method === first.toLowerCase());
  if (mode === undefined) return { focus: text };
  const focus = space === -1 ? "" : text.slice(space + 1).trim();
  if (focus.length > 0 && !mode.takesFocus) {
    return { error: `/compact ${mode.method} takes no focus text: it makes no model call, so there is nothing to steer` };
  }
  return { method: mode.method, ...(focus.length > 0 ? { focus } : {}) };
}
