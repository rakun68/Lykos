// The tool: seven actions over the client in `lsp-client.ts`.
//
// **Why it exists next to `grep` and `ast_grep`.** `grep` finds a name,
// `ast_grep` finds a shape, and neither knows what anything MEANS. Ask either
// one where `greet` is defined and you get every line that says `greet`,
// including the comment, the string literal and the unrelated method on
// another class. The language server has the compiler's own answer, and for
// `definition`, `references` and `rename` that is not a better heuristic, it
// is a different kind of answer — a rename driven by a text match is how a
// codemod silently renames somebody else's identifier.
//
// **The tier is the CEILING, not the common case (D6, and this is a
// correction).** The registry declared `lsp` at the `read` tier, which is
// true of six of these seven actions and false of `rename`. A tool whose
// declared tier is wrong for one of its actions is exactly the "unenforced
// invariant" CLAUDE.md warns this project keeps rediscovering, so the row now
// declares `soft-write` — the highest tier any action of this tool can reach
// — and the rationale says so. There is deliberately no second registry row:
// two rows for one tool would be two answers to "what may this do", and the
// one that is wrong would be the one a specialist restriction read.
//
// **A rename is ONE approval for the whole workspace edit (D7), and it is
// `ast_edit`'s shape on purpose.** The server returns edits spanning files;
// this tool applies them in memory, renders one unified diff per file, and
// puts every file through `authorizeEditBody()` BEFORE writing any of them.
// Approval is what writes; declining any file writes nothing anywhere. The
// only thing that differs from `ast_edit` is where the edits came from — a
// compiler rather than a pattern — and that difference must not produce a
// second apply protocol.
//
// **A missing server is an answer, not an error (D4).** A language with no
// configured server, or one whose executable is not on the machine, comes
// back as ordinary text naming the configuration key and the command that was
// looked for — the rule `web_search` follows for a missing key. A spawn error
// never reaches the model, because a stack trace is not something a model can
// act on and "install this, or configure that" is.
//
// **THE SCHEMA TAX, RECORDED AT THE MOMENT THE TOOL IS ADDED (AGENTS.md rule
// 3): this tool rides NO request.** Mounted with `hidden` prompt presence
// (D9), reached through `tool_call`. The measured numbers are asserted in
// `lsp.test.ts` so a description that doubles the bill fails a test rather
// than passing silently.

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import {
  defineTool,
  generateDiffString,
  generateUnifiedPatch,
  type EditToolDetails,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { USELESS_DETAILS } from "../loop/tool-result-prune.js";
import { ApprovalDeniedError, authorizeEditBody, type ApprovalGate, type DenialLog } from "../gate/approval.js";
import {
  LspPositionError,
  LspNotReadyError,
  LspTimeoutError,
  lspNotReadyMessage,
  applyLspTextEdits,
  displayPosition,
  documentLines,
  pathForUri,
  positionFor,
  type LspClient,
  type LspPosition,
  type LspServerPool,
  type LspTextEdit,
} from "./lsp-client.js";

export const LSP_TOOL_NAME = "lsp";

/** The seven this ticket ships. Code actions, formatting and raw passthrough are explicitly not in it. */
export const LSP_ACTIONS = [
  "definition",
  "references",
  "hover",
  "symbols",
  "diagnostics",
  "rename",
  "status",
] as const;

export type LspAction = (typeof LSP_ACTIONS)[number];

/** How many locations one result prints before it says it stopped. A hundred call sites is an answer nobody reads. */
export const LSP_MAX_LOCATIONS = 50;

/** How many diagnostics one file reports before the rest are counted rather than printed. */
export const LSP_MAX_DIAGNOSTICS = 50;

/**
 * How long `diagnostics` waits for the server's first `publishDiagnostics`
 * after opening a file, and how long it then waits to see whether a later
 * publish supersedes it.
 *
 * Two numbers rather than one because the first publish is often the
 * syntax-only pass: reporting it as final is how a file with a type error
 * comes back clean. The settle window is short enough that the common case —
 * one publish and no second — costs a fifth of a second.
 */
export const LSP_DIAGNOSTICS_WAIT_MS = 5000;
export const LSP_DIAGNOSTICS_SETTLE_MS = 400;

/**
 * How long an EMPTY publish waits to be superseded before it is believed.
 *
 * Longer than the settle window above, and deliberately so. Two empty
 * publishes are routine and neither means "clean": closing a document makes
 * `typescript-language-server` clear its diagnostics immediately, and the
 * reopen's syntax-only pass can also come back empty before the type-checked
 * answer arrives. Measured here, that answer lands about a second and a half
 * after the open, once the project has loaded. Believing the first empty
 * publish reports a file with a type error as clean — and that failure has no
 * error in it anywhere, only an empty list that reads as good news, which is
 * why it gets the generous window and a non-empty publish does not.
 */
export const LSP_DIAGNOSTICS_EMPTY_SETTLE_MS = 2500;

/**
 * The model-facing contract. Exported so `ledger/tool-catalog.ts` can be
 * asserted equal to it rather than re-typed beside it — a catalog entry that
 * drifts from the tool mis-prices the tax, silently.
 */
export const LSP_DESCRIPTION =
  "Ask the compiler instead of guessing from a text search. Actions: `definition` and `references` (where a symbol " +
  "is declared, and everywhere it is used), `hover` (its type), `symbols` (what one file declares), `diagnostics` " +
  "(what the compiler says about one file), `rename` (rewrite every reference to it across every file), and " +
  "`status` (which servers are configured and running). A position is `file` plus `line` (1-indexed) plus `symbol`, " +
  "a substring on that line — write `name#2` for the second occurrence on it. Columns are never asked for. `rename` " +
  "is shown as a diff for a human to approve and approval is what writes: declining writes nothing anywhere. A " +
  "language with no configured server says so and names what would configure it.";

export const LSP_PARAMETERS = Type.Object({
  action: Type.String({
    description: "definition, references, hover, symbols, diagnostics, rename, or status.",
  }),
  file: Type.Optional(
    Type.String({ description: "The file to ask about. Required for every action except status." }),
  ),
  line: Type.Optional(
    Type.Number({ description: "1-indexed line the symbol is on. Required for definition, references, hover and rename." }),
  ),
  symbol: Type.Optional(
    Type.String({ description: "A substring on that line naming the symbol, e.g. 'greet' or 'greet#2' for its second occurrence." }),
  ),
  new_name: Type.Optional(Type.String({ description: "The new identifier. Required for rename." })),
  timeout: Type.Optional(Type.Number({ description: "Seconds to wait for one server answer (default 20)." })),
});

export interface LspToolOpts {
  cwd: string;
  gate: ApprovalGate;
  denials?: DenialLog;
  /** The session's pool. Owned by the session, not by this tool: one server per language, killed at session end (D5). */
  pool: LspServerPool;
}

// ---------------------------------------------------------------------------
// Protocol shapes, read defensively
// ---------------------------------------------------------------------------

interface RawRange {
  start: LspPosition;
  end: LspPosition;
}

interface RawLocation {
  uri?: string;
  range?: RawRange;
  targetUri?: string;
  targetRange?: RawRange;
  targetSelectionRange?: RawRange;
}

export interface ResolvedLocation {
  path: string;
  range: RawRange;
}

/**
 * `Location`, `Location[]`, `LocationLink` and `LocationLink[]` are all legal
 * answers to the same request, and a server may pick any of them. Normalizing
 * here rather than per action means `definition` and `references` cannot
 * disagree about which shape they understood.
 */
export function normalizeLocations(result: unknown): ResolvedLocation[] {
  if (result === null || result === undefined) return [];
  const items = Array.isArray(result) ? result : [result];
  const out: ResolvedLocation[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const raw = item as RawLocation;
    const uri = raw.uri ?? raw.targetUri;
    const range = raw.range ?? raw.targetSelectionRange ?? raw.targetRange;
    if (uri === undefined || range === undefined) continue;
    out.push({ path: pathForUri(uri), range });
  }
  return out;
}

/** Hover contents come back as a string, a markup object, a marked string, or an array of any of those. */
export function extractHoverText(contents: unknown): string {
  if (contents === null || contents === undefined) return "";
  if (typeof contents === "string") return contents.trim();
  if (Array.isArray(contents)) return contents.map(extractHoverText).filter((s) => s !== "").join("\n").trim();
  if (typeof contents === "object") {
    const record = contents as { value?: unknown; contents?: unknown };
    if (typeof record.value === "string") return record.value.trim();
    if (record.contents !== undefined) return extractHoverText(record.contents);
  }
  return "";
}

/** LSP `SymbolKind`, 1-indexed. Printed rather than the number, because "12" tells a model nothing. */
const SYMBOL_KINDS: readonly string[] = [
  "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor",
  "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array",
  "object", "key", "null", "enum-member", "struct", "event", "operator", "type-parameter",
];

export function symbolKindName(kind: unknown): string {
  return typeof kind === "number" && kind >= 1 && kind <= SYMBOL_KINDS.length
    ? SYMBOL_KINDS[kind - 1]!
    : "symbol";
}

const SEVERITIES: readonly string[] = ["error", "warning", "info", "hint"];

export function severityName(severity: unknown): string {
  return typeof severity === "number" && severity >= 1 && severity <= SEVERITIES.length
    ? SEVERITIES[severity - 1]!
    : "diagnostic";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * How a path is shown to the model: relative to the session's cwd with
 * forward slashes, or absolute when it falls outside.
 *
 * The same answer `search.ts` and `ast.ts` give, and for the same reason —
 * the one reader of these paths is the model's next `read` or `edit` call,
 * and `edit` resolves a relative path against the cwd.
 */
export function displayPath(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return absolutePath;
  return rel.split("\\").join("/");
}

function toAbsolute(cwd: string, given: string): string {
  return isAbsolute(given) ? resolve(given) : resolve(cwd, given);
}

/** One location as `path:line:col`, with the source line beside it when it can be read. */
function renderLocation(cwd: string, location: ResolvedLocation, sources: Map<string, string[]>): string {
  const { line, column } = displayPosition(location.range.start);
  const head = `${displayPath(cwd, location.path)}:${line}:${column}`;
  const text = sources.get(location.path)?.[line - 1];
  return text === undefined ? head : `${head}  ${text.trim()}`;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

interface Target {
  absolutePath: string;
  display: string;
  /** The raw bytes as text. Positions are resolved against exactly this, and so is a rename's rewrite. */
  raw: string;
  client: LspClient;
  uri: string;
}

export function buildLspTool(opts: LspToolOpts): ToolDefinition {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

  /** Open the file with the right server, or return the ordinary text D4 asks for. */
  async function target(
    file: string | undefined,
    action: string,
    readyWaitMs: number | undefined,
  ): Promise<Target | { unavailable: string }> {
    if (file === undefined || file.trim() === "") {
      throw new Error(`lykos lsp: ${action} needs a file. Give the path you want the compiler asked about.`);
    }
    const absolutePath = toAbsolute(opts.cwd, file.trim());
    let raw: string;
    try {
      raw = await readFile(absolutePath, "utf8");
    } catch {
      throw new Error(`lykos lsp: ${displayPath(opts.cwd, absolutePath)} cannot be read. Nothing was asked of any server.`);
    }
    const got = await opts.pool.clientFor(absolutePath);
    if (!got.ok) return { unavailable: got.reason };
    // D8: a position request against a document the server has never been
    // told about comes back empty, which reads as "no definition" and is a
    // lie. Every action opens first, once — and waits for the server to say
    // it has looked at the file, because an answer given before the project
    // is loaded is a plausible WRONG location rather than an empty one.
    // T160: past the project-load wait it is an explicit not-ready error the
    // model sees and can retry, never an answer given anyway.
    let uri: string;
    try {
      uri = await got.client.ensureReady(absolutePath, raw, ...(readyWaitMs === undefined ? [] : ([readyWaitMs] as const)));
    } catch (err) {
      if (err instanceof LspNotReadyError) throw new Error(`lykos lsp: ${err.message}`);
      throw err;
    }
    return { absolutePath, display: displayPath(opts.cwd, absolutePath), raw, client: got.client, uri };
  }

  function positionOf(t: Target, line: number | undefined, symbol: string | undefined, action: string): LspPosition {
    if (line === undefined) {
      throw new Error(
        `lykos lsp: ${action} needs a line. Give the 1-indexed line the symbol is on, and \`symbol\` — a substring on it.`,
      );
    }
    return positionFor(t.raw, line, symbol);
  }

  return defineTool({
    name: LSP_TOOL_NAME,
    label: "LSP",
    description: LSP_DESCRIPTION,
    promptSnippet: "Ask the language server where a symbol is defined, used, or renamed",
    promptGuidelines: [
      "Use this rather than grep when the question is about a symbol rather than about a string: grep finds the comment and the unrelated method, the compiler does not.",
      "A rename here rewrites every reference the compiler knows about, in one approval. Reach for it instead of an ast_edit pattern whenever the thing being renamed is a symbol.",
    ],
    parameters: LSP_PARAMETERS,
    async execute(_toolCallId, params) {
      const action = String(params.action ?? "").trim() as LspAction;
      if (!(LSP_ACTIONS as readonly string[]).includes(action)) {
        throw new Error(
          `lykos lsp: unknown action ${JSON.stringify(params.action)}. What exists: ${LSP_ACTIONS.join(", ")}.`,
        );
      }
      const timeoutMs =
        typeof params.timeout === "number" && params.timeout > 0 ? Math.floor(params.timeout * 1000) : undefined;

      if (action === "status") return renderStatus(opts);

      // An explicit `timeout` is how long the caller is willing to wait for
      // this call, so it caps the project-load wait too rather than being
      // spent entirely on the request that follows it.
      const got = await target(params.file, action, timeoutMs);
      if ("unavailable" in got) {
        // D4: ordinary text, `success: false`, no throw. The model can act on
        // "configure this"; it cannot act on a spawn error.
        return { ...text(got.unavailable), details: { action, success: false, configured: false } };
      }

      try {
        switch (action) {
          case "definition":
          case "references":
            return await runNavigation(opts, got, action, positionOf(got, params.line, params.symbol, action), timeoutMs);
          case "hover":
            return await runHover(opts, got, positionOf(got, params.line, params.symbol, action), timeoutMs);
          case "symbols":
            return await runSymbols(opts, got, timeoutMs);
          case "diagnostics":
            return await runDiagnostics(opts, got, timeoutMs);
          case "rename":
            return await runRename(opts, got, params.line, params.symbol, params.new_name, timeoutMs);
        }
      } catch (err) {
        // A timeout and a bad position are both things the model can fix, so
        // they keep their own messages rather than being flattened into one.
        if (err instanceof LspTimeoutError) throw new Error(`lykos lsp: ${err.message}`);
        if (err instanceof LspNotReadyError) throw new Error(`lykos lsp: ${err.message}`);
        if (err instanceof LspPositionError) throw new Error(`lykos lsp: ${err.message}`);
        throw err;
      }
    },
  }) as ToolDefinition;
}

function renderStatus(opts: LspToolOpts): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  const rows = opts.pool.status();
  const lines =
    rows.length === 0
      ? [`No language servers are configured. Add one under \`lsp.servers\` in .lykos/config.yaml.`]
      : rows.map((row) => {
          const where =
            row.found === undefined
              ? `not found — \`${row.command}\` is neither in this project's node_modules nor on PATH`
              : row.running
                ? `running (pid ${row.pid})`
                : "configured, not started";
          return `${row.key}: ${where}  [${row.extensions.join(" ")}]`;
        });
  return {
    content: [{ type: "text" as const, text: ["Language servers:", ...lines.map((l) => `  ${l}`)].join("\n") }],
    details: { action: "status", success: true, servers: rows },
  };
}

async function runNavigation(
  opts: LspToolOpts,
  t: Target,
  action: "definition" | "references",
  position: LspPosition,
  timeoutMs: number | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  const method = action === "definition" ? "textDocument/definition" : "textDocument/references";
  const params =
    action === "definition"
      ? { textDocument: { uri: t.uri }, position }
      : { textDocument: { uri: t.uri }, position, context: { includeDeclaration: true } };
  const raw = await t.client.request<unknown>(method, params, timeoutMs);
  const locations = normalizeLocations(raw);
  const noun = action === "definition" ? "definition" : "reference";
  if (locations.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `No ${noun} found. The server was asked about ${t.display}:${displayPosition(position).line}:` +
            `${displayPosition(position).column}, so check that \`symbol\` names the identifier you meant rather ` +
            `than a word inside a string or a comment.`,
        },
      ],
      details: { action, success: true, count: 0, ...USELESS_DETAILS },
    };
  }
  // The source line beside each hit, read once per file rather than once per
  // location: a `references` result over a hot file is dozens of hits in one
  // place, and reading it dozens of times would be dozens of syscalls for one
  // answer.
  const sources = new Map<string, string[]>();
  for (const location of locations.slice(0, LSP_MAX_LOCATIONS)) {
    if (sources.has(location.path)) continue;
    try {
      sources.set(location.path, documentLines(await readFile(location.path, "utf8")));
    } catch {
      // Outside the project, inside a package, or gone. The location itself
      // is still the answer; only the context line is missing.
    }
  }
  const shown = locations.slice(0, LSP_MAX_LOCATIONS);
  const lines = [
    `${locations.length} ${noun}${locations.length === 1 ? "" : "s"}:`,
    ...shown.map((location) => `  ${renderLocation(opts.cwd, location, sources)}`),
  ];
  if (shown.length < locations.length) {
    lines.push(`  ... and ${locations.length - shown.length} more, not shown.`);
  }
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { action, success: true, count: locations.length },
  };
}

async function runHover(
  opts: LspToolOpts,
  t: Target,
  position: LspPosition,
  timeoutMs: number | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  void opts;
  const raw = await t.client.request<{ contents?: unknown } | null>(
    "textDocument/hover",
    { textDocument: { uri: t.uri }, position },
    timeoutMs,
  );
  const hover = extractHoverText(raw?.contents);
  return {
    content: [
      {
        type: "text" as const,
        text: hover === "" ? "No hover information at that position." : hover,
      },
    ],
    details: { action: "hover", success: true, empty: hover === "" },
  };
}

interface RawSymbol {
  name?: string;
  kind?: number;
  detail?: string;
  range?: RawRange;
  selectionRange?: RawRange;
  location?: { range?: RawRange };
  children?: RawSymbol[];
}

/** Both symbol shapes, flattened to lines. `DocumentSymbol` nests; `SymbolInformation` does not. */
export function renderSymbols(symbols: readonly RawSymbol[], depth = 0): string[] {
  const out: string[] = [];
  for (const symbol of symbols) {
    const range = symbol.selectionRange ?? symbol.range ?? symbol.location?.range;
    const line = range === undefined ? "?" : String(displayPosition(range.start).line);
    out.push(
      `${"  ".repeat(depth + 1)}${symbolKindName(symbol.kind)} ${symbol.name ?? "(unnamed)"}` +
        `${symbol.detail === undefined || symbol.detail === "" ? "" : ` ${symbol.detail}`} — line ${line}`,
    );
    if (symbol.children !== undefined && symbol.children.length > 0) {
      out.push(...renderSymbols(symbol.children, depth + 1));
    }
  }
  return out;
}

async function runSymbols(
  opts: LspToolOpts,
  t: Target,
  timeoutMs: number | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  void opts;
  const raw = await t.client.request<RawSymbol[] | null>(
    "textDocument/documentSymbol",
    { textDocument: { uri: t.uri } },
    timeoutMs,
  );
  const symbols = Array.isArray(raw) ? raw : [];
  if (symbols.length === 0) {
    return {
      content: [{ type: "text" as const, text: `${t.display} declares no symbols the server could see.` }],
      details: { action: "symbols", success: true, count: 0, ...USELESS_DETAILS },
    };
  }
  return {
    content: [{ type: "text" as const, text: [`Symbols in ${t.display}:`, ...renderSymbols(symbols)].join("\n") }],
    details: { action: "symbols", success: true, count: symbols.length },
  };
}

interface RawDiagnostic {
  range?: RawRange;
  severity?: number;
  code?: unknown;
  source?: string;
  message?: string;
}

export function renderDiagnostics(display: string, diagnostics: readonly RawDiagnostic[]): string {
  if (diagnostics.length === 0) return `${display}: no diagnostics. The compiler is happy with this file.`;
  const ordered = [...diagnostics].sort(
    (a, b) => (a.severity ?? 9) - (b.severity ?? 9) || (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0),
  );
  const shown = ordered.slice(0, LSP_MAX_DIAGNOSTICS);
  const lines = shown.map((diagnostic) => {
    const where = diagnostic.range === undefined ? "?" : (() => {
      const { line, column } = displayPosition(diagnostic.range.start);
      return `${line}:${column}`;
    })();
    const code = diagnostic.code === undefined || diagnostic.code === null ? "" : ` [${String(diagnostic.code)}]`;
    return `  ${where} ${severityName(diagnostic.severity)}${code}: ${diagnostic.message ?? ""}`;
  });
  const head = `${display}: ${ordered.length} diagnostic${ordered.length === 1 ? "" : "s"}.`;
  return shown.length < ordered.length
    ? [head, ...lines, `  ... and ${ordered.length - shown.length} more, not shown.`].join("\n")
    : [head, ...lines].join("\n");
}

async function runDiagnostics(
  opts: LspToolOpts,
  t: Target,
  timeoutMs: number | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  // Re-open, so the answer describes what is on disk NOW rather than what the
  // server was told about earlier in the session. A diagnostics result that
  // silently describes a stale document is worse than no diagnostics: it is
  // the one answer that would make a model stop looking.
  const wait = timeoutMs ?? LSP_DIAGNOSTICS_WAIT_MS;
  t.client.close(t.absolutePath);
  // Key on the absolute PATH, never on the URI. `publishCount`,
  // `waitForPublish` and `diagnosticsFor` all normalize what they are handed
  // through `normalizeFsPath`, which resolves a filesystem path; handing it a
  // `file://` URI produces a string that matches nothing the publish handler
  // ever stored, so the wait times out and a file with a type error reports
  // clean. That is the one diagnostics answer a model cannot recover from, and
  // it fails silently — there is no error anywhere, only an empty list.
  const before = t.client.publishCount(t.absolutePath);
  t.client.ensureOpen(t.absolutePath, t.raw);

  // **Keep waiting while publishes keep arriving.** A close is itself a
  // publish — `typescript-language-server` clears the file's diagnostics the
  // moment the document goes away — and the reopen's real answer follows a
  // second or more later, once the project is loaded. Accepting the first
  // publish therefore reports a file with a type error as clean, which is the
  // one diagnostics answer a model cannot recover from: it is not an error, it
  // is an empty list that looks like good news.
  //
  // So: wait for a publish, and if it is empty, wait again for the next one,
  // until either a publish carries something or the settle window passes with
  // nothing new. The common case — one publish and no second — costs one
  // settle window; the expensive case is bounded by `wait`.
  const deadline = Date.now() + wait;
  const empties = Math.min(LSP_DIAGNOSTICS_EMPTY_SETTLE_MS, wait);
  let arrived = false;
  let seen = before;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (!(await t.client.waitForPublish(t.absolutePath, seen, remaining))) break;
    arrived = true;
    seen = t.client.publishCount(t.absolutePath);
    if (t.client.diagnosticsFor(t.absolutePath).length === 0) {
      // Empty, and empty is the answer that has to be earned. Give the next
      // publish a window before believing it: measured against
      // `typescript-language-server` on this machine, the clear that follows a
      // close lands immediately and the type-checked answer follows about a
      // second and a half later, once the project has loaded. A clean file
      // therefore costs one of these windows, which is the price of not
      // reporting a broken file as clean.
      if (!(await t.client.waitForPublish(t.absolutePath, seen, empties))) break;
      seen = t.client.publishCount(t.absolutePath);
      if (t.client.diagnosticsFor(t.absolutePath).length === 0) continue;
    }
    // Something was published. Give a superseding publish one short window and
    // then stop — a server that keeps revising forever is not a thing this
    // tool waits out.
    await t.client.waitForPublish(t.absolutePath, seen, LSP_DIAGNOSTICS_SETTLE_MS);
    break;
  }
  // T160: nothing published for the reopened document means the server has
  // not looked at it — the not-ready case. An empty list here would read as
  // "clean", which is the one diagnostics answer a model cannot recover from.
  if (!arrived) throw new LspNotReadyError(lspNotReadyMessage(t.client.name, t.display, wait));
  const diagnostics = t.client.diagnosticsFor(t.absolutePath) as RawDiagnostic[];
  const body = renderDiagnostics(t.display, diagnostics);
  return {
    content: [{ type: "text" as const, text: body }],
    details: { action: "diagnostics", success: true, count: diagnostics.length, published: true },
  };
}

// ---------------------------------------------------------------------------
// rename (D7)
// ---------------------------------------------------------------------------

interface RawWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{ textDocument?: { uri?: string }; edits?: LspTextEdit[] }>;
}

/**
 * Both `WorkspaceEdit` shapes, collapsed to one map.
 *
 * `changes` and `documentChanges` are alternatives in the protocol and a
 * server may send either; `typescript-language-server` sends `changes`.
 * Reading only the one the tests happen to exercise would be a tool that
 * silently renames nothing against the next server somebody configures.
 */
export function collectWorkspaceEdits(edit: RawWorkspaceEdit | null | undefined): Map<string, LspTextEdit[]> {
  const out = new Map<string, LspTextEdit[]>();
  const add = (uri: string, edits: readonly LspTextEdit[]): void => {
    const path = pathForUri(uri);
    const existing = out.get(path);
    if (existing === undefined) out.set(path, [...edits]);
    else existing.push(...edits);
  };
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) {
    if (Array.isArray(edits)) add(uri, edits);
  }
  for (const change of edit?.documentChanges ?? []) {
    const uri = change.textDocument?.uri;
    // A `documentChanges` entry with no `textDocument` is a create/rename/
    // delete file operation. This ticket does not do file operations, and
    // silently dropping one would apply half of what the server asked for.
    if (uri !== undefined && Array.isArray(change.edits)) add(uri, change.edits);
  }
  return out;
}

/** What a rename would do to one file, computed but not yet approved or written. */
interface StagedRename {
  absolutePath: string;
  display: string;
  before: string;
  after: string;
  edits: number;
  diff: string;
  patch: string;
  firstChangedLine: number | undefined;
}

async function runRename(
  opts: LspToolOpts,
  t: Target,
  line: number | undefined,
  symbol: string | undefined,
  newName: unknown,
  timeoutMs: number | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: EditToolDetails | Record<string, unknown> }> {
  if (typeof newName !== "string" || newName.trim() === "") {
    throw new Error("lykos lsp: rename needs `new_name`. A rename with no new name is a mistake, not a no-op.");
  }
  if (line === undefined) {
    throw new Error(
      "lykos lsp: rename needs a line. Give the 1-indexed line the symbol is on, and `symbol` — a substring on it.",
    );
  }
  const position = positionFor(t.raw, line, symbol);
  const result = await t.client.request<RawWorkspaceEdit | null>(
    "textDocument/rename",
    { textDocument: { uri: t.uri }, position, newName: newName.trim() },
    timeoutMs,
  );
  const byFile = collectWorkspaceEdits(result);
  if (byFile.size === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `The server returned no edits, so nothing was written. Either that position is not a renameable ` +
            `symbol — check that \`symbol\` names the identifier rather than a word in a string or a comment — or ` +
            `the new name is the one it already has.`,
        },
      ],
      details: { action: "rename", success: true, applied: false, filesTouched: 0, changedFiles: [] },
    };
  }

  // ---- Compute the whole rewrite BEFORE asking for anything (D7) ----
  const staged: StagedRename[] = [];
  const failures: string[] = [];
  for (const [absolutePath, edits] of [...byFile.entries()].sort()) {
    let before: string;
    try {
      before = await readFile(absolutePath, "utf8");
    } catch (err) {
      failures.push(
        `${displayPath(opts.cwd, absolutePath)}: cannot be read (${err instanceof Error ? err.message : String(err)}).`,
      );
      continue;
    }
    const after = applyLspTextEdits(before, edits);
    if (after === before) continue;
    const display = displayPath(opts.cwd, absolutePath);
    // The diff is computed on LF text so the rendering is readable; the bytes
    // written are `after`, which still carries whatever endings the file had,
    // because every edit is a slice of the original.
    const { diff, firstChangedLine } = generateDiffString(toLf(before), toLf(after));
    staged.push({
      absolutePath,
      display,
      before,
      after,
      edits: edits.length,
      diff,
      patch: generateUnifiedPatch(display, toLf(before), toLf(after)),
      firstChangedLine,
    });
  }
  if (failures.length > 0) {
    throw new Error(
      `lykos lsp: the rename touches ${failures.length} file${failures.length === 1 ? "" : "s"} this session ` +
        `cannot read, so nothing was written anywhere.\n${failures.map((f) => `  - ${f}`).join("\n")}`,
    );
  }
  if (staged.length === 0) {
    return {
      content: [{ type: "text" as const, text: "Every edit the server returned rewrote text to what was already there, so nothing was written." }],
      details: { action: "rename", success: true, applied: false, filesTouched: 0, changedFiles: [] },
    };
  }

  // ---- One approval per file, all of them before any write (D7) ----
  const summary = `apply lsp rename to ${JSON.stringify(newName.trim())} (${staged.length} file${staged.length === 1 ? "" : "s"})`;
  for (const file of staged) {
    try {
      await authorizeEditBody(opts.cwd, opts.gate, file.absolutePath, summary, file.patch, opts.denials);
    } catch (err) {
      if (err instanceof ApprovalDeniedError) {
        throw new ApprovalDeniedError(
          `${err.message} A rename is all-or-nothing across ${staged.length} file${staged.length === 1 ? "" : "s"}, ` +
            `so nothing was written anywhere — a symbol renamed in some of its files and not the others does not compile.`,
        );
      }
      throw err;
    }
  }

  // ---- Only now does anything reach the disk ----
  const lines: string[] = [];
  let total = 0;
  for (const file of staged) {
    await writeFile(file.absolutePath, file.after, "utf8");
    total += file.edits;
    // The server's copy of this document is now stale, and a stale document
    // answers the next question about a symbol that no longer exists there.
    t.client.close(file.absolutePath);
    lines.push(`${file.edits} edit${file.edits === 1 ? "" : "s"} in ${file.display}`);
  }
  lines.unshift(
    `Renamed to ${newName.trim()}: ${total} edit${total === 1 ? "" : "s"} across ${staged.length} file${staged.length === 1 ? "" : "s"}.`,
  );

  // One file's diff is renderable; several are not, and the interface shows
  // one payload per tool result. The same choice `ast_edit` makes, for the
  // same reason.
  const only = staged.length === 1 ? staged[0]! : undefined;
  // T159: every file the rename wrote, as displayed (relative, `/`), so the
  // ledger's `edited_files` names all of them, not only the file it was called on.
  const changedFiles = staged.map((f) => f.display);
  const details: (EditToolDetails & { changedFiles: string[] }) | Record<string, unknown> =
    only === undefined
      ? { action: "rename", success: true, applied: true, totalEdits: total, filesTouched: staged.length, changedFiles }
      : {
          diff: only.diff,
          patch: only.patch,
          ...(only.firstChangedLine !== undefined ? { firstChangedLine: only.firstChangedLine } : {}),
          changedFiles,
        };
  return { content: [{ type: "text" as const, text: lines.join("\n") }], details };
}

/**
 * Line endings only, for the DIFF — never for what is written.
 *
 * `ast_edit` has to restore a file's own line ending because it rewrites
 * whole regions of LF-normalized text. A rename does not: every edit is a
 * slice of the original bytes with a short identifier substituted into it, so
 * a CRLF file comes out of `applyLspTextEdits` still CRLF and nothing has to
 * put it back. The normalization here exists so the unified patch a human
 * reads does not show `^M` on every line.
 */
function toLf(value: string): string {
  return value.indexOf("\r") === -1 ? value : value.replace(/\r\n?/g, "\n");
}
