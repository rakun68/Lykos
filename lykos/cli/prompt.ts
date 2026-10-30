// `lykos prompt --show` — T28.1/T28.2 (`docs/10-phase2-tasks.md`,
// `docs/05-cli-and-config.md` §4). Host-side only: no Pi tool, nothing here
// is visible to the model, and nothing this command does enters the head
// (T28.4). It renders `session/head-view.ts`, which in turn calls the same
// assembly functions a session calls — so this file is a renderer and
// nothing else.
//
// The blocks are printed VERBATIM, not summarised. The question the command
// exists to answer is "what was my agent actually told?", and a paraphrase
// of the head is the abstraction this project has decided not to have.
//
// The fingerprint section is deliberately two lines rather than one. The
// ledger's `calls.prefix_fingerprint` covers Pi's full assembled prompt,
// which the host cannot read; printing it beside the boot-block hash with
// the scopes named is honest, and claiming they should match would not be.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { openLedgerSync } from "../ledger/use.js";
import { buildHeadView, type HeadBlock, type HeadView } from "../session/head-view.js";
import { loadConfig } from "../config/load.js";
import { resolveExtensions } from "../config/extensions.js";
import { REPO_MAP_EXTENSION } from "../extensions/defaults/index.js";
import { formatShare, estimateTokensChars4 } from "../ledger/tool-schema.js";
import { stdoutWrite } from "../tui/io-mode.js";
import {
  applySpecialist,
  OFF_LIMITS_HEADING,
  type SpecialistContext,
  type SpecialistFields,
} from "../session/specialist-apply.js";
import { applyToolDeltas, resolveStandaloneTools } from "../tools.js";
import { specialistStreamMessage } from "../session/specialist-stream.js";
import { MODE_INFO, type InteractionMode } from "../gate/modes.js";
import {
  PONYTAIL_HEADING,
  resolvePonytailAndSpecialistHeads,
  resolveSpecialistOverrideHeads,
} from "../session/ponytail-head.js";

export interface PromptOptions {
  json?: boolean;
  tools?: readonly string[];
  subagents?: boolean;
  /** When present and the file exists, the latest recorded prefix fingerprint is shown beside the boot hash. */
  ledgerPath?: string;
  /** Specialists ticket 01: `--specialist <name>`, resolved through the same sixth config layer a real session boots with. */
  specialist?: string;
  /** T217: `--output-style <name>`. */
  outputStyle?: string;
  /** Specialists ticket 07: context for specialist prompt assembly ("session-start" | "switch" | "subagent"). Defaults to "session-start". */
  context?: SpecialistContext;
}

const RULE = "─".repeat(72);

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function kib(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * The most recent recorded fingerprint, or null. Read-only, and a failure to
 * read is not an error for this command — the head is printable with no
 * ledger at all.
 */
async function latestRecordedFingerprint(
  ledgerPath: string,
): Promise<{ fingerprint: string; sessionId: string } | null> {
  if (!existsSync(ledgerPath)) return null;
  try {
    const { Ledger } = await import("../ledger/ledger.js");
    const ledger = openLedgerSync(ledgerPath);
    const row = ledger.db
      .prepare(
        `SELECT prefix_fingerprint AS fingerprint, session_id AS sessionId
           FROM calls
          WHERE prefix_fingerprint IS NOT NULL
          ORDER BY started_utc DESC, rowid DESC
          LIMIT 1`,
      )
      .get() as { fingerprint: string; sessionId: string } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function blockLine(b: HeadBlock, widths: { heading: number }): string {
  const state = b.enabled ? padLeft(String(b.tokens), 6) : padLeft("off", 6);
  const bytes = b.enabled ? padLeft(kib(b.bytes), 9) : padLeft("—", 9);
  const why = b.enabled ? b.note : b.flag ? `disabled by ${b.flag}` : b.note || "disabled";
  return `  ${pad(b.heading, widths.heading)} ${state} tok ${bytes}   ${pad(b.task, 4)} ${why}`;
}

export function renderHeadView(
  view: HeadView,
  recorded: { fingerprint: string; sessionId: string } | null,
): string {
  const out: string[] = [];
  const env = view.environment;
  const headingWidth = Math.max(...view.blocks.map((b) => b.heading.length), 14);

  out.push("lykos prompt — the head as a session receives it, standalone or delegated");
  out.push(RULE);
  out.push(`environment   cwd ${env.cwd} · ${env.platform} · project ${env.project}`);
  out.push(`              git_head ${env.gitHead}`);
  out.push(`              pi agent dir ${env.agentDir}`);
  out.push("");

  out.push("blocks, in assembly order");
  out.push(
    `  ${pad("(pi base)", headingWidth)} ${padLeft("?", 6)} tok ${padLeft("?", 9)}   ${pad("—", 4)} Pi's own prompt: assembled in-process, not readable from the host`,
  );
  for (const b of view.blocks) out.push(blockLine(b, { heading: headingWidth }));
  out.push("");

  out.push(`context files, frozen at boot via agentsFilesOverride  (T21${view.contextFilesEnabled ? "" : ", DISABLED"})`);
  if (!view.contextFilesEnabled) {
    out.push("  none — LYKOS_PROMPT_DIET=0 turns agentsFilesOverride off entirely");
  } else if (view.contextFiles.length === 0) {
    out.push("  none found (no AGENTS.override.md, AGENTS.md, or CLAUDE.md on the walk)");
  } else {
    for (const f of view.contextFiles) {
      out.push(`  ${pad(f.path, headingWidth + 12)} ${padLeft(String(f.tokens), 6)} tok ${padLeft(kib(f.bytes), 9)}   ${f.kind}`);
    }
  }
  out.push("");

  const t = view.toolset;
  out.push("tool schemas");
  if (t.complete && t.tokens !== null && t.bytes !== null) {
    out.push(
      `  ${pad(`${t.count} tools`, headingWidth)} ${padLeft(String(t.tokens), 6)} tok ${padLeft(kib(t.bytes), 9)}   ${t.names.join(", ")}`,
    );
  } else {
    out.push(`  not measurable — ${t.unknown.join(", ")} absent from the schema catalog`);
  }
  out.push(`  live tool-result cap ${view.toolResultMaxBytes} bytes (T21, LYKOS_TOOL_RESULT_MAX_BYTES)`);
  out.push("");

  out.push(RULE);
  const total = view.totals;
  const schema = total.schemaTokens === null ? "?" : String(total.schemaTokens);
  const sum = total.total === null ? "not computable (toolset unmeasured)" : `${total.total} tok`;
  out.push(
    `totals        head ${total.headTokens} + context ${total.contextTokens} + schemas ${schema}  =  ${sum}`,
  );
  if (total.total !== null && total.schemaTokens !== null && total.total > 0) {
    out.push(`              schema share of the Lykos-controlled head: ${formatShare(total.schemaTokens / total.total)}`);
  }
  out.push(`              basis ${view.tokensBasis} — an estimate, never a billed count`);
  out.push("");

  out.push(`fingerprint   boot  sha256:${shortHash(view.fingerprints.bootHead)}`);
  out.push(`                    ${view.fingerprints.bootHead}`);
  if (recorded) {
    out.push(`              ledger calls.prefix_fingerprint (latest, session ${recorded.sessionId}):`);
    out.push(`                    ${recorded.fingerprint}`);
  } else {
    out.push("              ledger no call has recorded a prefix fingerprint yet");
  }
  out.push(`              note  ${view.fingerprints.note}`);
  out.push("");

  out.push(RULE);
  for (const b of view.blocks) {
    if (!b.enabled) {
      // T65: print the block's own note beside the flag. A block can be off
      // for a reason the flag does not describe — the memory block is absent
      // when the store is empty, not because LYKOS_MEMORY_INJECT was set —
      // and printing only the flag would state a cause that is not the cause.
      const why = b.note && b.note.length > 0 ? (b.flag ? `${b.note}; ${b.flag}` : b.note) : `${b.flag}`;
      out.push(`${b.heading}  — NOT INJECTED (${why})`);
      out.push("");
      continue;
    }
    out.push(`${b.text}`);
    out.push("");
  }

  if (view.specialistStreamMessage) {
    out.push(RULE);
    out.push("specialist stream message");
    out.push("");
    out.push(view.specialistStreamMessage);
    out.push("");
  }

  return out.join("\n");
}

export async function runPrompt(cwd: string, opts: PromptOptions = {}): Promise<number> {
  const { resolved, layers } = loadConfig({
    cwd,
    ...(opts.specialist !== undefined ? { specialistName: opts.specialist } : {}),
    ...(opts.outputStyle !== undefined ? { flags: { output_style: opts.outputStyle } } : {}),
  });
  const context: SpecialistContext = opts.context ?? "session-start";
  const neutralHead = context !== "subagent" && context !== "switch";

  const view = buildHeadView({
    cwd,
    outputStyleName: resolved.output_style,
    memory: resolved.memory,
    // T158 (ADR-0028): the map is the `lykos-repo-map` default extension, and
    // its entry in `extensions:` is its only switch.
    repoMapDeclared: resolveExtensions(resolved.extensions).extensions.some((e) => e.name === REPO_MAP_EXTENSION),
    repoMap: resolved.retrieval.repo_map,
    skills: resolved.skills,
    ...(resolved.instructions ? { specialistInstructions: resolved.instructions } : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.subagents !== undefined ? { subagents: opts.subagents } : {}),
    neutralHead,
    specialistName: opts.specialist ?? "build",
    delegated: context === "subagent",
  });

  const specLayer = layers.find((l) => l.name === "specialist");
  const specialistFields: SpecialistFields | undefined = specLayer?.present
    ? {
        ...(specLayer.value as SpecialistFields),
        ...(resolved.instructions !== undefined ? { instructions: resolved.instructions } : {}),
      }
    : undefined;

  const isChild = false;
  const baseTools = opts.tools ?? resolved.tools;
  const hasSpecialistTools =
    resolved.tools !== undefined ||
    (resolved.tools_add !== undefined && resolved.tools_add.length > 0) ||
    (resolved.tools_remove !== undefined && resolved.tools_remove.length > 0);
  const defaultToolNames = resolveStandaloneTools({
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.subagents !== undefined ? { subagents: opts.subagents } : {}),
    isChild,
  });
  const specialistToolNames = hasSpecialistTools
    ? applyToolDeltas(
        resolveStandaloneTools({
          ...(baseTools !== undefined ? { tools: baseTools } : {}),
          ...(opts.subagents !== undefined ? { subagents: opts.subagents } : {}),
          isChild,
        }),
        resolved.tools_add,
        resolved.tools_remove,
      )
    : undefined;

  const app = applySpecialist({
    ...(opts.specialist !== undefined ? { name: opts.specialist } : {}),
    ...(specialistFields !== undefined ? { specialist: specialistFields } : {}),
    context,
    defaultToolNames,
    ...(specialistToolNames !== undefined ? { specialistToolNames } : {}),
  });


  // Ask the same function `boot.ts` asks rather than deciding from
  // `replacesDefaultHead` alone. The two answers differ for one real input: a
  // specialist that declares `prompt_mode: override` AND whose instructions open
  // with `PONYTAIL_REPLACE_MARKER` keeps a `## lykos-ponytail` block, because the
  // marker path puts the replacement text under that heading. Filtering on the
  // mode alone deletes the specialist's own instructions from this output — an
  // inspection command showing a head the session will not produce, which is the
  // one thing this command must never do.
  const heads = app.replacesDefaultHead && !neutralHead
    ? resolveSpecialistOverrideHeads(resolved.instructions)
    : resolvePonytailAndSpecialistHeads(resolved.instructions);
  if (heads.ponytail === "" && !neutralHead) {
    view.blocks = view.blocks.filter((b) => b.heading !== PONYTAIL_HEADING);
  }
  if (app.offLimitsPromptPart && !neutralHead) {
    const text = app.offLimitsPromptPart;
    view.blocks.push({
      heading: OFF_LIMITS_HEADING,
      task: "specialists ticket 02",
      note: "tools disallowed by specialist",
      enabled: true,
      flag: null,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      tokens: estimateTokensChars4(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    });
  }

  if (neutralHead && (opts.specialist !== undefined || resolved.instructions !== undefined)) {
    const mode = (resolved.mode as InteractionMode) ?? "manual";
    const modeLabel = MODE_INFO[mode]?.label ?? "Manual";
    const allowedTools = app.tools.filter((t) => t.disposition === "resident").map((t) => t.name);
    view.specialistStreamMessage = specialistStreamMessage({
      name: opts.specialist ?? "build",
      ...(resolved.instructions !== undefined ? { instructions: resolved.instructions } : {}),
      ...(app.offLimitToolNames.length > 0 ? { offLimits: app.offLimitToolNames } : {}),
      modeLabel,
      ...(app.offLimitToolNames.length > 0 ? { tools: allowedTools } : {}),
    });
  }

  const headTokens = view.blocks.filter((b) => b.enabled).reduce((n, b) => n + b.tokens, 0);
  view.totals.headTokens = headTokens;
  if (view.totals.schemaTokens !== null) {
    view.totals.total = headTokens + view.totals.contextTokens + view.totals.schemaTokens;
  }

  const recorded = opts.ledgerPath ? await latestRecordedFingerprint(opts.ledgerPath) : null;

  if (opts.json) {
    stdoutWrite(`${JSON.stringify({ ...view, recordedPrefixFingerprint: recorded }, null, 2)}\n`);
    return 0;
  }
  stdoutWrite(`${renderHeadView(view, recorded)}\n`);
  return 0;
}
