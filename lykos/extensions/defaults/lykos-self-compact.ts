// P4 T151 — `lykos-self-compact`, the `self-compact` context strategy as a
// default extension. Part 1: the gauge (spec stories 41, 42, 45-53, 56).
// P4 T152 — part 2: the handoff (stories 43, 44, 54, 55, 57, 58).
//
// The agent sees its own context filling. At the NOTICE line the next model
// call carries a short note saying where the window stands; at the WARNING line
// it carries the instruction to finish the current step, write a note to self
// and call `self_compact`; past the CUTOFF it is told once that only
// `self_compact` runs. Each is added to exactly one model call and dropped
// afterwards — never appended to the session, so it neither clutters the
// history nor moves the cached prefix (story 45; AGENTS.md rule 9). A tool,
// `context_usage`, shows the agent its usage, window, tier and thresholds on
// demand (story 46).
//
// **The handoff** (T152). `self_compact({ note })` saves the note and ends the
// turn (an abort at `turn_end`, as `lykos-continuation` does — no further
// model call is made on the full context). Once the session is idle
// (`agent_settled`) the extension compacts through `ctx.compact()`, the call
// Pi's `examples/extensions/trigger-compact.ts` makes, and then hands the note
// back as its own text block of a custom message, byte for byte, which starts
// the next turn (story 44). Past the cutoff every other tool call is refused
// through `tool_call` with a reason naming `self_compact` (story 43).
//
// **Nothing is lost to a failure** (story 55). The note is an `appendEntry`
// record before anything else happens. A compaction that fails is retried, up
// to `SELF_COMPACT_MAX_ATTEMPTS` in a row; one that is cancelled, or that
// fails every attempt, leaves the note pending and is tried again at the next
// idle moment (or at once by `/self-compact`).
//
// **Resume** (story 58). Every record is also copied by the host into the
// session directory; `lykos resume` re-appends an unfinished handoff to the
// resumed session's entries before its first turn. A resumed session's context
// is rebuilt from disk rather than carried over, so what is left of the
// handoff is the note: it is returned once, with the person's first message,
// and recorded `delivered` so a later resume does not return it again. No
// compaction is run or recorded for it — none happened.
//
// **The ledger** (story 54). Each compaction attempt — the handoff's, and
// Pi's own underneath while this strategy is active — is a `compaction`
// record; the host writes them to the ledger's `compactions` table at the
// session's end with the model, tier, tokens and result.
//
// **`/self-compact`** (story 57) asks the agent to write its note and compact
// now; with a note already pending it retries the compaction instead.
//
// **The method chain** (P17 T190, ADR-0040). A compaction Pi starts with no
// agent note pending goes through `compaction.method_order` (default note,
// handoff, shake, summary) from `session_before_compact`: the handoff side
// call returns a templated note as Pi's summary; shake records which tool
// results to drop, applies them on `context` from then on, and cancels Pi's
// compaction; otherwise Pi's summary runs. A compaction the agent's own note
// asked for is the `note` method and is left to Pi, as before. Each row in
// `compactions` names the method and what fell through before it.
//
// **Public Pi API only** (spec story 26): `context`, `tool_call`, `turn_end`,
// `agent_settled`, `before_agent_start`, `session_before_compact`,
// `session_compact(_failed)`,
// `ctx.getContextUsage()`, `ctx.compact()`, `ctx.abort()`, `pi.registerTool`,
// `pi.registerCommand`, `pi.appendEntry`, `pi.sendMessage` and
// `ctx.sessionManager.getEntries()`. Nothing here reaches into Lykos's session.
//
// **Its setting is `context_strategy: self-compact`** plus the `self_compact:`
// table, carried in by `SELF_COMPACT_POLICY_ENV`, which boot sets from the
// resolved configuration before Pi loads extensions. Any other strategy loads
// it inert: no tool, no handler, no command. Loaded outside Lykos, with no
// policy in the environment, it also does nothing.
//
// **Prompts live under `.lykos/`** (story 56): `.lykos/prompts/self-compact/
// {notice,warning,cutoff,command}.md` in the project, then in the home
// directory, replace the shipped text. They are read once and frozen for the
// session.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { buildSessionContext, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { CompactionResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_METHOD_ORDER, parseCompactArgs, runChain, type CompactionMethod, type FellThrough } from "../../loop/compaction-chain.js";
import {
  applyShakes,
  planShake,
  SHAKE_ENTRY_TYPE,
  SHAKE_MIN_SAVINGS,
  SHAKE_PROTECT_TOKENS,
  shakenIds,
  shakeRecordsFromEntries,
  type ShakeRecord,
} from "../../loop/shake.js";
import { applyPrunes, pruneMap, pruneRecordsFromEntries } from "../../loop/tool-result-prune.js";
import { observeCacheKey, requestHandoffDocument, type HandoffUsage, type LiveCacheKey } from "./self-compact-handoff.js";
import {
  compactionUsage,
  HANDOFF_USAGE_ENTRY_TYPE,
  COMPACTION_INSTRUCTIONS,
  NO_MODEL_CALL,
  type CompactionUsage,
  CONTEXT_USAGE_TOOL_NAME,
  cutoffRefusal,
  decodeSelfCompactPolicyEnv,
  DEFAULT_COMMAND_PROMPT,
  DEFAULT_CUTOFF_PROMPT,
  DEFAULT_NOTICE_PROMPT,
  DEFAULT_WARNING_PROMPT,
  formatTokens,
  levelFor,
  levelRank,
  NOTE_HEADER,
  renderGuidance,
  resolveSelfCompact,
  SELF_COMPACT_COMMAND,
  SELF_COMPACT_ENTRY_TYPE,
  SELF_COMPACT_MAX_ATTEMPTS,
  SELF_COMPACT_NOTE_TYPE,
  SELF_COMPACT_POLICY_ENV,
  SELF_COMPACT_PROMPTS_DIR,
  SELF_COMPACT_REQUEST_TYPE,
  SELF_COMPACT_TOOL_NAME,
  selfCompactRecordsFromEntries,
  unfinishedHandoff,
  type CompactionRecord,
  type CompactionTrigger,
  type HandoffRecord,
  type SelfCompactLevel,
  type SelfCompactPolicy,
  type SelfCompactRecord,
} from "../../loop/self-compact.js";
import { missingNoteSections, SELF_COMPACT_SECTION_LIST } from "../../loop/self-compact-template.js";

/** The tool's description; `ledger/tool-catalog.ts` carries the same text so the schema tax stays measured. */
export const CONTEXT_USAGE_DESCRIPTION =
  "Show how full your context window is: the tokens in it now, the window, the self-compact tier that window " +
  "falls in, and the notice, warning and cutoff lines for this model. Takes no arguments and changes nothing. " +
  "The token count is an estimate and is unknown right after a compaction until the next model response.";

/** `self_compact`'s description; `ledger/tool-catalog.ts` carries the same text. */
export const SELF_COMPACT_DESCRIPTION =
  "Compact your own context at a point you choose, keeping a note to self. Write `note` for yourself after the " +
  `compaction, under the \`##\` headings ${SELF_COMPACT_SECTION_LIST}: exact file paths, commands, decisions and ` +
  "open questions, nothing you would have to rediscover. The note is saved at once; the compaction runs as soon as this " +
  "turn ends, so end your turn after calling it; afterwards the note is returned to you word for word. Past the " +
  "cutoff this is the only tool that runs.";

/** `self_compact`'s one argument, described; `ledger/tool-catalog.ts` carries the same text. */
export const SELF_COMPACT_NOTE_DESCRIPTION =
  "Your note to self, returned to you word for word after the compaction. Write it for someone with none of this " +
  `conversation in front of them, under these \`##\` headings in this order: ${SELF_COMPACT_SECTION_LIST}. ` +
  "Progress has Done, In Progress and Pending under it. Give exact paths, symbols and commands. A note that " +
  "leaves a heading out is still saved.";

interface Figures {
  tokens: number | null;
  contextWindow: number;
}

function figures(ctx: ExtensionContext): Figures | undefined {
  const usage = ctx.getContextUsage();
  const contextWindow =
    usage !== undefined && usage.contextWindow > 0 ? usage.contextWindow : (ctx.model?.contextWindow ?? 0);
  if (contextWindow <= 0) return undefined;
  return { tokens: usage?.tokens ?? null, contextWindow };
}

function readPrompt(cwd: string, file: string, fallback: string): string {
  for (const base of [cwd, homedir()]) {
    const path = join(base, ...SELF_COMPACT_PROMPTS_DIR, file);
    try {
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8").trim();
        if (text.length > 0) return text;
      }
    } catch {
      // An unreadable override is not a reason to lose the guidance.
    }
  }
  return fallback;
}

/**
 * Pi declines to compact a context that is already compacted or too small to
 * cut (`AgentSession.compact`). Retrying changes nothing: the context is
 * intact and small, so the handoff ends by returning the note.
 */
function isNothingToCompact(error: Error): boolean {
  return /Nothing to compact|Already compacted/.test(error.message);
}

function isCancelled(error: Error): boolean {
  return error.name === "AbortError" || /cancell?ed|aborted/i.test(error.message);
}

export default function lykosSelfCompact(pi: ExtensionAPI): void {
  // Read once, at load: a later session in the same process sets its own.
  const policy: SelfCompactPolicy | null = decodeSelfCompactPolicyEnv(process.env[SELF_COMPACT_POLICY_ENV]);
  if (policy === null || !policy.enabled) return;
  const { table, specialist } = policy;
  const methodOrder: readonly CompactionMethod[] = policy.methodOrder ?? DEFAULT_METHOD_ORDER;
  let announced: SelfCompactLevel = "below";
  /**
   * What the chain decided for the Pi-started compaction now in flight, kept
   * from `session_before_compact` to the `session_compact(_failed)` that
   * records it. Pi runs one compaction at a time.
   */
  let chosen: { method: CompactionMethod; tried: FellThrough[]; usage?: HandoffUsage } | undefined;
  /** Set when this extension cancelled Pi's compaction on purpose (a shake, or a refused `/compact`), so the failed event that follows is not a row of its own. */
  let cancelledOnPurpose = false;
  /** The prompt-cache key the last live request sent, for the side call to share (see self-compact-handoff.ts). */
  let liveCacheKey: LiveCacheKey | undefined;
  const prompts = new Map<string, string>();

  // The handoff in progress, if any. `inherited` marks one found in the
  // session's entries at the first event — a resumed session's.
  let handoff: HandoffRecord | undefined;
  let inherited = false;
  let initialized = false;
  /** Set by `self_compact`; the `turn_end` that follows ends the run. */
  let savedThisTurn = false;
  /** Set by `/self-compact`; the next handoff says the person asked for it. */
  let requestedByCommand = false;
  /** True while one of OUR compactions runs, so Pi's events for it are not recorded twice. */
  let compactingOurs = false;
  let finishing = false;

  const prompt = (cwd: string, name: "notice" | "warning" | "cutoff" | "command", fallback: string): string => {
    let text = prompts.get(name);
    if (text === undefined) {
      text = readPrompt(cwd, `${name}.md`, fallback);
      prompts.set(name, text);
    }
    return text;
  };

  const resolve = (ctx: ExtensionContext, contextWindow: number) =>
    resolveSelfCompact(table, {
      contextWindow,
      ...(ctx.model !== undefined ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
      ...(specialist !== undefined ? { specialist } : {}),
    });

  const record = (r: SelfCompactRecord): void => {
    pi.appendEntry(SELF_COMPACT_ENTRY_TYPE, r);
  };

  const init = (ctx: ExtensionContext): void => {
    if (initialized) return;
    initialized = true;
    const found = unfinishedHandoff(selfCompactRecordsFromEntries(ctx.sessionManager.getEntries()));
    if (found !== undefined) {
      handoff = found;
      inherited = true;
    }
  };

  const setPhase = (phase: HandoffRecord["phase"], via?: HandoffRecord["via"]): HandoffRecord => {
    const next: HandoffRecord = { ...handoff!, phase, ts: new Date().toISOString(), ...(via !== undefined ? { via } : {}) };
    record(next);
    handoff = phase === "delivered" ? undefined : next;
    return next;
  };

  const noteMessage = (h: HandoffRecord) => ({
    customType: SELF_COMPACT_NOTE_TYPE,
    content: [
      { type: "text" as const, text: NOTE_HEADER },
      { type: "text" as const, text: h.note },
    ],
    display: true,
    details: { id: h.id },
  });

  const compactionRecord = (
    ctx: ExtensionContext,
    fields: Pick<CompactionRecord, "trigger" | "result" | "attempt" | "tokens_before" | "tokens_after"> & {
      error?: string;
      handoff_id?: string;
      /** T190: which chain method this attempt was, what fell through before it, and its model call's usage. */
      method: CompactionMethod;
      tried: FellThrough[];
      usage: CompactionUsage;
    },
  ): CompactionRecord => {
    const f = figures(ctx);
    const resolved = f !== undefined ? resolve(ctx, f.contextWindow) : undefined;
    return {
      kind: "compaction",
      id: randomUUID(),
      ...(fields.handoff_id !== undefined ? { handoff_id: fields.handoff_id } : {}),
      trigger: fields.trigger,
      strategy: "self-compact",
      model: ctx.model !== undefined ? `${ctx.model.provider}/${ctx.model.id}` : null,
      tier: resolved !== undefined ? formatTokens(resolved.tier.window) : null,
      context_window: f?.contextWindow ?? null,
      tokens_before: fields.tokens_before,
      tokens_after: fields.tokens_after,
      result: fields.result,
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      attempt: fields.attempt,
      ts: new Date().toISOString(),
      method: fields.method,
      fell_through: fields.tried,
      ...fields.usage,
    };
  };

  /**
   * The context as the live turn sends it: Pi's own, rebuilt from the session's
   * current BRANCH (never every entry: a forked session has others), with the
   * recorded prunes and shakes applied. The one rebuild the side call, shake and
   * the after-estimate all read.
   */
  const liveMessages = (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    const messages = buildSessionContext(branch, ctx.sessionManager.getLeafId()).messages;
    applyPrunes(messages, pruneMap(pruneRecordsFromEntries(branch)));
    applyShakes(messages, shakenIds(shakeRecordsFromEntries(branch)));
    return { messages, branch };
  };

  /** Pi's estimate of the context as the next request will send it: the figure a compaction leaves behind. */
  const estimateContextTokens = (ctx: ExtensionContext): number =>
    liveMessages(ctx).messages.reduce((sum, m) => sum + estimateTokens(m), 0);

  /** What the chain decided for the Pi-started compaction that just ended, once; a summary by default. */
  const takeChosen = (): NonNullable<typeof chosen> => {
    const via = chosen ?? { method: "summary" as const, tried: [] as FellThrough[] };
    chosen = undefined;
    return via;
  };

  const compactOnce = (ctx: ExtensionContext): Promise<{ ok: true; result: CompactionResult } | { ok: false; error: Error }> =>
    new Promise((settle) => {
      compactingOurs = true;
      ctx.compact({
        customInstructions: COMPACTION_INSTRUCTIONS,
        onComplete: (result) => {
          compactingOurs = false;
          settle({ ok: true, result });
        },
        onError: (error) => {
          compactingOurs = false;
          settle({ ok: false, error });
        },
      });
    });

  /**
   * Compacts (retrying a failure) and returns the note. Leaves the handoff
   * pending when every attempt fails or one is cancelled — the next idle
   * moment tries again.
   */
  const finish = async (ctx: ExtensionContext): Promise<void> => {
    const h = handoff;
    if (h === undefined || finishing) return;
    finishing = true;
    try {
      if (h.phase === "pending") {
        let compacted = false;
        let declined = false;
        // The agent's note asked for this compaction, so it is the note method's (Pi's summariser
        // still writes the summary underneath); with `note` out of the order it is Pi's summary.
        const noteAttempt = { method: (methodOrder.includes("note") ? "note" : "summary") as CompactionMethod, tried: [] };
        for (let attempt = 1; attempt <= SELF_COMPACT_MAX_ATTEMPTS; attempt += 1) {
          const before = figures(ctx)?.tokens ?? null;
          const outcome = await compactOnce(ctx);
          if (outcome.ok) {
            record(
              compactionRecord(ctx, {
                handoff_id: h.id,
                trigger: h.trigger,
                result: "ok",
                attempt,
                tokens_before: before ?? outcome.result.tokensBefore,
                tokens_after: outcome.result.estimatedTokensAfter ?? null,
                ...noteAttempt,
                usage: compactionUsage(outcome.result.usage),
              }),
            );
            setPhase("compacted");
            compacted = true;
            break;
          }
          const cancelled = isCancelled(outcome.error);
          record(
            compactionRecord(ctx, {
              handoff_id: h.id,
              trigger: h.trigger,
              result: cancelled ? "cancelled" : "failed",
              error: outcome.error.message,
              attempt,
              tokens_before: before,
              tokens_after: null,
              ...noteAttempt,
              usage: compactionUsage(undefined),
            }),
          );
          if (cancelled) break;
          if (isNothingToCompact(outcome.error)) {
            declined = true;
            break;
          }
        }
        if (declined) {
          const done = setPhase("delivered", "uncompacted");
          pi.sendMessage(noteMessage(done), { triggerTurn: true });
          return;
        }
        if (!compacted) {
          if (ctx.hasUI) {
            ctx.ui.notify("self-compact: compaction did not complete; the note is kept and will be tried again", "warning");
          }
          return;
        }
      }
      const done = setPhase("delivered", "compaction");
      // Starts the next turn: the note is the first thing the agent reads.
      pi.sendMessage(noteMessage(done), { triggerTurn: true });
    } finally {
      finishing = false;
    }
  };

  pi.on("context", (event, ctx) => {
    // T190: a shake is a recorded decision applied to every request after it (ADR-0039's way).
    const shaken = shakenIds(shakeRecordsFromEntries(ctx.sessionManager.getBranch()));
    applyShakes(event.messages, shaken);
    const unchanged = shaken.size > 0 ? { messages: event.messages } : undefined;
    const f = figures(ctx);
    if (f === undefined || f.tokens === null) return unchanged;
    const resolved = resolve(ctx, f.contextWindow);
    if (resolved === undefined) return unchanged; // below the smallest tier: Pi's compaction is in charge
    const level = levelFor(f.tokens, resolved.thresholds);
    if (levelRank(level) <= levelRank(announced)) {
      announced = level; // a fall re-arms the lines below it; equal is already said
      return unchanged;
    }
    announced = level;
    const template =
      level === "notice"
        ? prompt(ctx.cwd, "notice", DEFAULT_NOTICE_PROMPT)
        : level === "warning"
          ? prompt(ctx.cwd, "warning", DEFAULT_WARNING_PROMPT)
          : prompt(ctx.cwd, "cutoff", DEFAULT_CUTOFF_PROMPT);
    const text = renderGuidance(template, {
      tokens: f.tokens,
      window: f.contextWindow,
      tier: resolved.tier,
      thresholds: resolved.thresholds,
    });
    return {
      messages: [
        ...event.messages,
        { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
      ],
    };
  });

  // Story 43: past the cutoff only `self_compact` runs.
  pi.on("tool_call", (event, ctx) => {
    init(ctx);
    if (event.toolName === SELF_COMPACT_TOOL_NAME) return undefined;
    const f = figures(ctx);
    if (f === undefined || f.tokens === null) return undefined;
    const resolved = resolve(ctx, f.contextWindow);
    if (resolved === undefined || levelFor(f.tokens, resolved.thresholds) !== "cutoff") return undefined;
    return { block: true, reason: cutoffRefusal(event.toolName, f.tokens, resolved.thresholds.cutoff) };
  });

  // The turn that saved a note is the last one on the full context.
  pi.on("turn_end", (_event, ctx) => {
    if (!savedThisTurn) return;
    savedThisTurn = false;
    ctx.abort();
  });

  // "Compacts once idle": the run is over, nothing is streaming.
  pi.on("agent_settled", async (_event, ctx) => {
    init(ctx);
    if (inherited) return; // a resumed session's handoff finishes with its first message
    await finish(ctx);
  });

  // A resumed session's unfinished handoff: the note comes back once, with the first message.
  pi.on("before_agent_start", (_event, ctx) => {
    init(ctx);
    if (!inherited || handoff === undefined) return undefined;
    inherited = false;
    const done = setPhase("delivered", "resume");
    return { message: noteMessage(done) };
  });

  // Pi's own compactions while this strategy is active: the last resort
  // underneath (story 38) is recorded beside the handoff's. T190: a compaction
  // Pi starts with no agent note goes through the method chain first.
  const piTrigger = (reason: "manual" | "threshold" | "overflow"): CompactionTrigger =>
    reason === "manual" ? "manual" : reason === "threshold" ? "pi-threshold" : "pi-overflow";

  // Observed, never changed: the cache key the live turn sends, which the handoff side call shares.
  pi.on("before_provider_request", (event, ctx) => {
    // Kept with the model it was sent to, and dropped when the newest request has none: a switch must not carry a key over.
    liveCacheKey = observeCacheKey(event.payload, ctx.model);
    return undefined;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    init(ctx);
    chosen = undefined;
    if (compactingOurs) return undefined; // the note's own compaction: finish() records it
    // T191: a manual `/compact <method>` runs that method alone for this one compaction; any other
    // text is the focus it always was. An automatic compaction has no instructions to read.
    const asked = event.reason === "manual" ? parseCompactArgs(event.customInstructions) : {};
    if ("error" in asked) {
      if (ctx.hasUI) ctx.ui.notify(asked.error, "warning");
      cancelledOnPurpose = true;
      return { cancel: true };
    }
    // A note already saved is the agent's own handoff: nothing for the chain to write. Pi's
    // summariser compacts, as for `finish`, and the note comes back after it. A method the person
    // named wins over it (ADR-0040): the note stays pending and is delivered at the next idle moment.
    if (asked.method === undefined && handoff !== undefined && handoff.phase === "pending") {
      chosen = { method: methodOrder.includes("note") ? "note" : "summary", tried: [] };
      return undefined;
    }
    const tokensBefore = event.preparation.tokensBefore;
    const order = asked.method !== undefined ? [asked.method] : methodOrder;
    const focus = asked.method !== undefined ? asked.focus : event.customInstructions;
    const outcome = await runChain<
      | { method: "handoff"; document: string; usage: HandoffUsage | undefined }
      | { method: "shake"; plan: ShakeRecord }
    >(
      order,
      {
        note: async () => ({ fell: "the agent left no note" }),
        handoff: async () => {
          // The live turn's tools, in its order, sent with tool choice none: they open the cached prefix.
          const all = new Map(pi.getAllTools().map((t) => [t.name, t]));
          const tools = pi
            .getActiveTools()
            .flatMap((name) => {
              const t = all.get(name);
              return t === undefined ? [] : [{ name: t.name, description: t.description, parameters: t.parameters }];
            });
          const made = await requestHandoffDocument(ctx, event.signal, liveMessages(ctx).messages, tools, {
            cacheKey: liveCacheKey,
            sessionId: ctx.sessionManager.getSessionId(),
            thinkingBudgets: policy.thinkingBudgets,
            transport: policy.transport,
          }, focus);
          if (made.failure !== undefined) {
            // The call was paid for whether or not it wrote a note: the usage rides the row's
            // fell_through entry and reaches `calls` through the session's usage entry.
            if (made.usage !== undefined) pi.appendEntry(HANDOFF_USAGE_ENTRY_TYPE, made.usage);
            return { fell: made.failure, ...(made.usage !== undefined ? { usage: compactionUsage(made.usage) } : {}) };
          }
          return { ran: { method: "handoff", document: made.document, usage: made.usage } };
        },
        shake: async () => {
          // Shake is no compaction to Pi: it cancels Pi's, and a cancelled compaction is not retried, so an
          // overflow that is waiting to retry its turn needs a real summary instead.
          if (event.willRetry) return { fell: "an overflow retry needs a summary, not a cancelled compaction" };
          const { messages, branch } = liveMessages(ctx);
          const plan = planShake(messages, shakenIds(shakeRecordsFromEntries(branch)), {
            protectTokens: SHAKE_PROTECT_TOKENS,
            minSavings: SHAKE_MIN_SAVINGS,
            protectedTools: [SELF_COMPACT_TOOL_NAME, CONTEXT_USAGE_TOOL_NAME],
          });
          if (plan === undefined) return { fell: "no tool result outside the recent tail is worth dropping" };
          return { ran: { method: "shake", plan } };
        },
      },
      () => event.signal.aborted,
    );
    const done = outcome.value;
    if (done?.method === "handoff") {
      chosen = { method: "handoff", tried: outcome.tried, ...(done.usage !== undefined ? { usage: done.usage } : {}) };
      return {
        compaction: {
          summary: done.document,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore,
          ...(done.usage !== undefined ? { usage: done.usage } : {}),
        },
      };
    }
    if (done?.method === "shake") {
      pi.appendEntry(SHAKE_ENTRY_TYPE, done.plan);
      record(
        compactionRecord(ctx, {
          trigger: piTrigger(event.reason),
          result: "ok",
          attempt: 1,
          tokens_before: tokensBefore,
          // An estimate: the measured figure Pi reported, less the chars/4 estimate of what the shake dropped.
          tokens_after: Math.max(0, tokensBefore - done.plan.tokens_saved),
          method: "shake",
          tried: outcome.tried,
          usage: NO_MODEL_CALL,
        }),
      );
      if (ctx.hasUI) {
        ctx.ui.notify(`self-compact: shook out ${done.plan.tool_call_ids.length} tool result(s), about ${done.plan.tokens_saved} tokens`, "info");
      }
      cancelledOnPurpose = true;
      return { cancel: true };
    }
    if (asked.method === "shake") {
      // Shake was asked for alone, and a summary is a model call nobody asked for: the compaction
      // fails, with the reason, instead of falling through to Pi's summariser.
      const reason = outcome.tried[0]?.reason ?? "the compaction was aborted";
      record(
        compactionRecord(ctx, {
          trigger: "manual",
          result: "failed",
          error: reason,
          attempt: 1,
          tokens_before: tokensBefore,
          tokens_after: null,
          method: "shake",
          tried: [],
          usage: NO_MODEL_CALL,
        }),
      );
      if (ctx.hasUI) ctx.ui.notify(`self-compact: /compact shake dropped nothing: ${reason}`, "warning");
      cancelledOnPurpose = true;
      return { cancel: true };
    }
    chosen = { method: "summary", tried: outcome.tried };
    return undefined;
  });

  pi.on("session_compact", (event, ctx) => {
    if (compactingOurs) return;
    const via = takeChosen();
    record(
      compactionRecord(ctx, {
        trigger: piTrigger(event.reason),
        result: "ok",
        attempt: 1,
        tokens_before: event.compactionEntry.tokensBefore ?? null,
        tokens_after: estimateContextTokens(ctx),
        method: via.method,
        tried: via.tried,
        usage: compactionUsage(via.usage ?? event.compactionEntry.usage),
      }),
    );
  });
  pi.on("session_compact_failed", (event, ctx) => {
    if (compactingOurs) return;
    if (cancelledOnPurpose) {
      cancelledOnPurpose = false; // our own cancellation (a shake, whose row is written, or a refused command, which has none), not a failed compaction
      return;
    }
    const via = takeChosen();
    record(
      compactionRecord(ctx, {
        trigger: piTrigger(event.reason),
        result: event.aborted ? "cancelled" : "failed",
        ...(event.errorMessage !== undefined ? { error: event.errorMessage } : {}),
        attempt: 1,
        tokens_before: null,
        tokens_after: null,
        method: via.method,
        tried: via.tried,
        usage: compactionUsage(via.usage),
      }),
    );
    // A handoff that wrote its note but whose compaction did not land was still paid for. Pi reports no usage
    // for a compaction that failed or was aborted, so the call reaches `calls` through this entry: exactly once.
    if (via.method === "handoff" && via.usage !== undefined) pi.appendEntry(HANDOFF_USAGE_ENTRY_TYPE, via.usage);
  });

  pi.registerTool({
    name: CONTEXT_USAGE_TOOL_NAME,
    label: "Context usage",
    description: CONTEXT_USAGE_DESCRIPTION,
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const f = figures(ctx);
      const out: Record<string, unknown> = {};
      if (f === undefined) {
        out.state = "unknown: the model reports no context window";
      } else {
        const resolved = resolve(ctx, f.contextWindow);
        out.tokens = f.tokens ?? "unknown until the next model response";
        out.window = f.contextWindow;
        if (f.tokens !== null) out.percent = Math.round((f.tokens / f.contextWindow) * 1000) / 10;
        if (resolved === undefined) {
          const smallest = table.tiers[0];
          out.self_compact = `off: the window is below the smallest tier${smallest !== undefined ? ` (${formatTokens(smallest.window)})` : ""}; Pi's own compaction is in charge`;
        } else {
          out.tier = formatTokens(resolved.tier.window);
          out.thresholds = { ...resolved.thresholds, source: resolved.source };
          if (f.tokens !== null) out.level = levelFor(f.tokens, resolved.thresholds);
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], details: out };
    },
  });

  pi.registerTool({
    name: SELF_COMPACT_TOOL_NAME,
    label: "Self-compact",
    description: SELF_COMPACT_DESCRIPTION,
    parameters: Type.Object({ note: Type.String({ description: SELF_COMPACT_NOTE_DESCRIPTION }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      init(ctx);
      const note = typeof (params as { note?: unknown }).note === "string" ? (params as { note: string }).note : "";
      if (note.trim().length === 0) {
        throw new Error("self_compact needs a note: write what you will need after the compaction, then call it again");
      }
      const replaced = handoff !== undefined;
      // T189: a note missing sections is saved all the same; the record says which.
      const missing = missingNoteSections(note);
      handoff = {
        kind: "handoff",
        id: handoff?.id ?? randomUUID(),
        phase: "pending",
        note,
        ...(missing.length > 0 ? { missing_sections: missing } : {}),
        trigger: requestedByCommand ? "command" : "agent",
        ts: new Date().toISOString(),
      };
      inherited = false;
      requestedByCommand = false;
      record(handoff);
      savedThisTurn = true;
      const text =
        `Note saved (${note.length} characters${replaced ? ", replacing the one saved before" : ""}` +
        `${missing.length > 0 ? `; missing sections: ${missing.join(", ")}` : ""}). ` +
        "The compaction runs as soon as this turn ends: end your turn now and call nothing else. " +
        "Afterwards the note is returned to you word for word.";
      return { content: [{ type: "text", text }], details: { id: handoff.id, characters: note.length } };
    },
  });

  pi.registerCommand(SELF_COMPACT_COMMAND, {
    description: "Ask the agent to write a note to self and compact now (retries a pending compaction)",
    handler: async (args, ctx) => {
      init(ctx);
      if (handoff !== undefined && !inherited && ctx.isIdle()) {
        // A note is already saved: compact now rather than asking for another.
        await finish(ctx);
        return;
      }
      requestedByCommand = true;
      const request = args.trim().length > 0 ? `\n\nThe person added: ${args.trim()}` : "";
      const text = prompt(ctx.cwd, "command", DEFAULT_COMMAND_PROMPT).replace("{request}", request);
      pi.sendMessage(
        { customType: SELF_COMPACT_REQUEST_TYPE, content: text, display: true },
        ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "steer" },
      );
    },
  });
}
