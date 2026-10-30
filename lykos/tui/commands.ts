// The one place that knows what commands exist.
//
// **The bug this closes.** There were two hand-maintained lists. `OWNED` in
// `s0.ts` decided what `parseInteractiveInput()` would dispatch;
// `COMMAND_REGISTRY` in `screen/completion.ts` decided what Tab would offer.
// Nothing kept them equal, and they had already drifted: `/rename` and
// `/name` dispatched but were absent from completion, so they could be typed
// and never discovered. T47.1's own module comment says the registry is
// "deliberately limited to what `parseInteractiveInput()` actually
// recognises", which was true when it was written and became false the next
// time a command was added to one list only. Two lists with a comment asking
// people to keep them in step is not a mechanism.
//
// **And it is what makes skills completable.** The roster of skills is
// discovered at boot and is different in every project, so the completion
// source cannot be a `const` array any more — it has to be something a
// runtime can add to. `setSkillCommands()` is that seam, called once from
// the session boot path with whatever Pi's discovery found.
//
// **Layering.** This lives in `tui/` rather than `tui/screen/` because both
// consumers must be able to import it: `s0.ts` (the parser) is not part of
// the full-screen surface, and having it reach into `tui/screen/` for the
// registry would point the dependency the wrong way — the parser would then
// only work where a screen exists.
//
// Naming rule, stated once because it decides three behaviours below: a
// **built-in always wins a bare name**. A skill called `help` does not
// shadow `/help`; it stays reachable as `/skill:help`, and `/skill:<name>`
// works for every skill whether or not it collides.

export type CostClass = "local" | "costed" | "refused";

/** T163: every source a slash command can come from, in the order dispatch tries a colliding name. */
export type CommandSource = "builtin" | "skill" | "extension" | "pi-extension";

export interface CommandSpec {
  /** `/name` as typed, including the leading slash. */
  name: string;
  costClass: CostClass;
  description: string;
  /** Completions for this command's first argument: a closed vocabulary, never a callback. */
  args?: readonly string[];
  /**
   * Where it came from. The completion popup shows this, so a `/foo` is never ambiguous about its origin.
   * T163: `pi-extension` is a command a Pi extension registered through Pi's `registerCommand`; typing
   * it sends it to Pi, which runs it.
   */
  source: CommandSource;
  /** Skills only: the skill name to dispatch, which may differ in case from the typed name. */
  skill?: string;
  /** Extensions only: which extension registered it, so `/foo` is never ambiguous about its origin. */
  extension?: string;
}

/**
 * P10.9 (ticket 21, D5): what the extension host hands this module.
 *
 * Names and descriptions only — deliberately NOT the handler. This module is
 * the one place that knows what commands exist; running one is the session's
 * job, and a `run` callback sitting in a module-level roster would be a
 * closure over one session's state that the next session in the process would
 * inherit. `session/interactive.ts` dispatches through the host it was given.
 */
export interface ExtensionCommandSpec {
  name: string;
  description: string;
  extension: string;
}

/** What the boot path hands us: whatever skill discovery found. */
export interface SkillLikeCommand {
  name: string;
  description?: string | undefined;
  /** Where the skill body lives. Named in the prompt so the model reads the real file rather than guessing at the instructions. */
  filePath?: string | undefined;
}

import { COMPACT_MODE_NAMES } from "../loop/compaction-chain.js";
import { EFFORT_LEVELS } from "./effort.js";
import { INTERACTION_MODES } from "../gate/modes.js";

/**
 * The built-in surface. Every entry here must be dispatched by
 * `parseInteractiveInput()` and every command it dispatches must be here —
 * `commands.test.ts` and `s0.test.ts` assert both directions, which is the
 * mechanism the old comment was standing in for.
 */
export const BUILTIN_COMMANDS: readonly CommandSpec[] = [
  { name: "/help", costClass: "local", description: "this list", source: "builtin" },
  { name: "/hotkeys", costClass: "local", description: "this list", source: "builtin" },
  { name: "/session", costClass: "local", description: "id, model, turns, tokens", source: "builtin" },
  { name: "/copy", costClass: "local", description: "last assistant message", source: "builtin" },
  { name: "/verbose", costClass: "local", description: "expand/collapse tool results", source: "builtin" },
  { name: "/thinking", costClass: "local", description: "show/hide reasoning blocks", source: "builtin" },
  // Reasoning effort is a per-request parameter, not part of the frozen
  // head — which is why this is `local` and not `refused` the way /specialist
  // is. It changes what the NEXT call costs, but nothing is spent running it.
  {
    name: "/effort",
    costClass: "local",
    description: "reasoning effort — bare shows the current level",
    args: EFFORT_LEVELS,
    source: "builtin",
  },
  { name: "/usage", costClass: "local", description: "tokens, cache and spend for this session", source: "builtin" },
  { name: "/context", costClass: "local", description: "what is occupying the context window", source: "builtin" },
  // T131: the mode surface, which used to be reachable only by Shift+Tab.
  {
    name: "/mode",
    costClass: "local",
    description: "interaction mode — bare shows the current one",
    args: INTERACTION_MODES,
    source: "builtin",
  },
  // T209 / ADR-0041: inspect or adjust permissions remembered per project.
  {
    name: "/permissions",
    costClass: "local",
    description: "view or adjust permissions: mode, outside rules, extra dirs, approvals",
    args: ["mode", "outside", "dir", "revoke"],
    source: "builtin",
  },
  { name: "/resume", costClass: "local", description: "continue an earlier session", source: "builtin" },
  { name: "/close-session", costClass: "local", description: "close this session and move it to Closed", source: "builtin" },
  // T131: present because they dispatch. Their absence here was the drift.
  { name: "/rename", costClass: "local", description: "name this session — bare reports the current name", source: "builtin" },
  { name: "/name", costClass: "local", description: "name this session — bare reports the current name", source: "builtin" },
  { name: "/exit", costClass: "local", description: "end the session", source: "builtin" },
  { name: "/quit", costClass: "local", description: "end the session", source: "builtin" },
  // /compact is the one people get wrong: compaction is a model call.
  {
    name: "/compact",
    costClass: "costed",
    description: "compact context now — a model call (shake: no model call, drops re-readable tool results)",
    args: COMPACT_MODE_NAMES,
    source: "builtin",
  },
  { name: "/followup", costClass: "costed", description: "queue a follow-up (delivered when idle)", source: "builtin" },
  // Ticket 04: no longer refused now that a real multi-specialist system
  // exists (tickets 01-03). Bare lists every discovered specialist with its
  // description, marking the active one; a name switches — it rebuilds the
  // resident tool surface (a real prefix break, recorded as one) and, where
  // the surface allows it, the model, thinking level and interaction mode.
  { name: "/specialist", costClass: "local", description: "list or switch specialist — bare lists; a name switches (records a prefix break)", source: "builtin" },
  { name: "/output-style", costClass: "local", description: "list or switch output style — bare lists; a name switches", source: "builtin" },
  { name: "/model", costClass: "local", description: "switch model for this session; next call may pay a cold prefix", source: "builtin" },
  // P14.6 ticket 06: the same login flow as `lykos login`, and the session's
  // credential pin. Both are free: neither sends anything to a model.
  { name: "/login", costClass: "local", description: "add a credential: /login <provider> [--api-key]", source: "builtin" },
  {
    name: "/credential",
    costClass: "local",
    description: "list this provider's credentials, pin one to this session, or /credential auto",
    source: "builtin",
  },
  { name: "/new", costClass: "refused", description: "refused — would rewrite the cache prefix", source: "builtin" },
];

/** Classification-only rows: never `/`-completion candidates, but `/help` and the cost legend describe them. */
export const INPUT_PREFIXES: readonly Omit<CommandSpec, "source">[] = [
  { name: "!!cmd", costClass: "local", description: "run locally, keep output out of context" },
  { name: "!cmd", costClass: "costed", description: "run locally, send output to the model" },
  { name: "prompt", costClass: "costed", description: "a bare prompt — sends to the model" },
];

const BUILTIN_BY_NAME = new Map(BUILTIN_COMMANDS.map((c) => [c.name.toLowerCase(), c]));

/** Bare command words a built-in owns, e.g. `help`. Used to resolve collisions. */
const BUILTIN_WORDS = new Set(BUILTIN_COMMANDS.map((c) => c.name.slice(1).toLowerCase()));

/**
 * **Module-level, and here is exactly why that is safe — and what would make
 * it unsafe.**
 *
 * Both reviews of T131 flagged this as process-global mutable state, which
 * it is. It survives because `setSkillCommands()` has precisely two callers,
 * the append-only and full-screen interactive boot paths in
 * `session/interactive.ts`, and those are mutually exclusive: one process runs
 * one interactive session, and that file's own module doc records that
 * `bootStandaloneSession()` is called exactly once. A subagent booted
 * in-process, `runStandaloneTask`, and the MCP worker never call this at all
 * — none of them has a composer or a completion popup to feed.
 *
 * **What would break it:** a second interactive session in one process, or
 * calling this from a subagent boot. Either would let one session's roster
 * silently become another's. If that day comes, the roster moves onto the
 * session object and `complete()`/`commandSpan()` take it as a parameter —
 * both are already pure apart from this one lookup. Tests reset it in
 * `beforeEach` for the same reason.
 */
let skills: readonly SkillLikeCommand[] = [];

/**
 * Ticket 04: `/specialist <name>`'s completion candidates — discovered at boot
 * per project, exactly like the skill roster above, and for the same
 * reason: this cannot be a `const` array. Module-level for the same safety
 * argument `skills` above already makes (one interactive session per
 * process); tests reset it in `beforeEach`.
 */
let specialistNames: readonly string[] = [];

/**
 * T217: `/output-style <name>`'s completion candidates — discovered at boot.
 */
let outputStyleNames: readonly string[] = [];

/**
 * P10.9 (ticket 21, D5): the commands Lykos extensions registered, on the same
 * terms and with the same safety argument as `skills` above — one interactive
 * session per process, replaced wholesale rather than appended to, and reset
 * by tests in `beforeEach`.
 *
 * A built-in still wins a bare name, exactly as it does against a skill: an
 * extension registering `help` does not shadow `/help`. Unlike a skill there
 * is no `/skill:` style escape, because a colliding extension command has a
 * name its author can simply change.
 */
let extensionCommands: readonly ExtensionCommandSpec[] = [];

/** Replace the registered extension-command roster. Called once per session from the boot path. */
export function setExtensionCommands(specs: readonly ExtensionCommandSpec[]): void {
  extensionCommands = specs
    .filter((c) => typeof c.name === "string" && c.name.length > 0)
    .map((c) => ({ ...c, name: c.name.replace(/^\//, "").toLowerCase() }));
}

/**
 * T163: a command a Pi extension registered (`pi.registerCommand`), as Pi's
 * extension runner resolves it — `name` is Pi's invocation name, which Pi
 * already suffixes (`foo:1`, `foo:2`) when two Pi extensions register the
 * same word. Handled by Pi: a typed one is sent to the session as text, and
 * Pi's prompt path runs the command before any model call.
 */
export interface PiCommandSpec {
  name: string;
  description: string;
  /** The Pi extension that registered it: its package or file name. */
  extension: string;
}

let piCommands: readonly PiCommandSpec[] = [];

/** T163: replace the Pi-extension command roster. Called once per session from the boot path. */
export function setPiExtensionCommands(specs: readonly PiCommandSpec[]): void {
  piCommands = specs
    .filter((c) => typeof c.name === "string" && c.name.length > 0)
    .map((c) => ({ ...c, name: c.name.replace(/^\//, "").toLowerCase() }));
}

/**
 * T163: the Pi-extension commands dispatch actually reaches. Dispatch tries a
 * skill, then a Lykos extension command, then a built-in, and only then hands
 * the text to Pi — so a Pi command whose word one of those owns can be typed
 * and never run. It is left out here and named by `commandConflicts()`.
 */
function reachablePiCommands(): readonly PiCommandSpec[] {
  return piCommands.filter(
    (c) => !BUILTIN_WORDS.has(c.name) && resolveSkillName(c.name) === undefined && resolveExtensionCommandName(c.name) === undefined,
  );
}

/** T163: Pi-extension commands as command specs, under the names Tab should offer. */
export function piExtensionCommandSpecs(): readonly CommandSpec[] {
  return reachablePiCommands().map((c) => ({
    name: `/${c.name}`,
    // As for a Lykos extension's command: nothing says whether it sends a
    // message, so it is never presented as free.
    costClass: "costed" as const,
    description: c.description.length > 0 ? c.description : `from the Pi extension ${c.extension}`,
    source: "pi-extension" as const,
    extension: c.extension,
  }));
}

/** T163: resolve a typed word to a Pi-extension command dispatch reaches, or undefined. */
export function resolvePiCommandName(word: string): string | undefined {
  const lower = word.replace(/^\//, "").toLowerCase();
  return reachablePiCommands().find((c) => c.name === lower)?.name;
}

/**
 * T163: every command a source registered that typing its name will not run,
 * because another source owns that word — one line each, naming both sources
 * and which one wins. Shown once when the session starts; never silently dropped.
 */
export function commandConflicts(): string[] {
  const out: string[] = [];
  const owner = (word: string): string | undefined => {
    if (resolveSkillName(word) !== undefined && !BUILTIN_WORDS.has(word)) return "a skill";
    if (resolveExtensionCommandName(word) !== undefined) return "a Lykos extension command";
    if (BUILTIN_WORDS.has(word)) return "the built-in";
    return undefined;
  };
  for (const c of extensionCommands) {
    if (BUILTIN_WORDS.has(c.name)) {
      out.push(`/${c.name} from the Lykos extension ${c.extension} is shadowed by the built-in /${c.name}; typing it runs the built-in`);
    } else if (resolveSkillName(c.name) !== undefined) {
      out.push(`/${c.name} from the Lykos extension ${c.extension} is shadowed by the skill ${c.name}; typing it runs the skill`);
    }
  }
  for (const c of piCommands) {
    const winner = owner(c.name);
    if (winner !== undefined) {
      out.push(`/${c.name} from the Pi extension ${c.extension} is shadowed by ${winner} /${c.name}; typing it runs ${winner}`);
    }
  }
  return out;
}

/** Registered extension commands as command specs, under the names Tab should offer. */
export function extensionCommandSpecs(): readonly CommandSpec[] {
  return extensionCommands
    .filter((c) => !BUILTIN_WORDS.has(c.name))
    .map((c) => ({
      name: `/${c.name}`,
      // Costed only when the command itself decides to send something; the
      // registration surface has no way to say, and claiming `local` for code
      // this repository did not write would be a promise nobody can keep.
      costClass: "costed" as const,
      description: c.description.length > 0 ? c.description : `from the extension ${c.extension}`,
      source: "extension" as const,
      extension: c.extension,
    }));
}

/** Resolve a typed command word to a registered extension command, or undefined. */
export function resolveExtensionCommandName(word: string): string | undefined {
  const lower = word.replace(/^\//, "").toLowerCase();
  if (BUILTIN_WORDS.has(lower)) return undefined;
  return extensionCommands.find((c) => c.name === lower)?.name;
}

/** Replace the registered specialist-name roster. Called once per session from the boot path, and again after a successful switch adds nothing new — discovery does not change mid-session, only which one is active. */
export function setSpecialistNames(names: readonly string[]): void {
  specialistNames = [...names];
}

export function setOutputStyleNames(names: readonly string[]): void {
  outputStyleNames = [...names];
}

/**
 * Replace the registered skill roster. Called once per session from the boot
 * path; replacing wholesale rather than appending is what keeps a re-scan
 * from leaving entries behind for skills that no longer exist.
 */
export function setSkillCommands(roster: readonly SkillLikeCommand[]): void {
  skills = roster.filter((s) => typeof s.name === "string" && s.name.length > 0);
}

/** A skill body is loaded and acted on, so invoking one costs a model call. */
function skillSpec(skill: SkillLikeCommand): CommandSpec {
  const collides = BUILTIN_WORDS.has(skill.name.toLowerCase());
  return {
    name: collides ? `/skill:${skill.name}` : `/${skill.name}`,
    costClass: "costed",
    description: skill.description && skill.description.length > 0 ? skill.description : "skill",
    source: "skill",
    skill: skill.name,
  };
}

/** Registered skills as command specs, each under the name Tab should offer for it. */
export function skillCommands(): readonly CommandSpec[] {
  return skills.map(skillSpec);
}

/** Everything, built-ins first. This is the source both completion and dispatch read. */
export function allCommands(): readonly CommandSpec[] {
  // Ticket 04 / T217: `/specialist`'s and `/output-style`'s args are the discovered rosters.
  const builtins = BUILTIN_COMMANDS.map((c) => {
    if (c.name === "/specialist") return { ...c, args: specialistNames };
    if (c.name === "/output-style") return { ...c, args: outputStyleNames };
    return c;
  });
  return [...builtins, ...skillCommands(), ...extensionCommandSpecs(), ...piExtensionCommandSpecs()];
}

/**
 * The `/`-completion candidates.
 *
 * `query` exists for one case: `/skill:` works at dispatch for EVERY skill,
 * including ones that do not collide with a built-in, but listing both forms
 * of every skill unconditionally would carry the whole roster twice in a
 * popup capped at five rows. So the `/skill:` forms are offered only once the
 * user has actually typed `/skill:`, which is exactly when they are useful.
 */
export function slashCandidates(query = ""): readonly CommandSpec[] {
  const base = allCommands().filter((c) => c.name.startsWith("/"));
  if (!query.toLowerCase().startsWith("/skill:")) return base;
  const explicit = skills
    .filter((s) => !BUILTIN_WORDS.has(s.name.toLowerCase()))
    .map((s) => ({ ...skillSpec(s), name: `/skill:${s.name}` }));
  return [...base, ...explicit];
}

/** Look one up by its typed form, `/name` included. */
export function findCommand(name: string): CommandSpec | undefined {
  const key = name.toLowerCase();
  return allCommands().find((c) => c.name.toLowerCase() === key);
}

/**
 * Resolve a typed command word to a skill name, or undefined when it is not
 * a skill. Accepts `skill:handoff` always, and bare `handoff` only when no
 * built-in owns that word — the collision rule, applied at dispatch so it
 * matches what completion offered.
 */
export function resolveSkillName(word: string): string | undefined {
  const lower = word.toLowerCase();
  const explicit = lower.startsWith("skill:");
  const wanted = explicit ? lower.slice("skill:".length) : lower;
  if (!explicit && BUILTIN_WORDS.has(wanted)) return undefined;
  return skills.find((s) => s.name.toLowerCase() === wanted)?.name;
}

/**
 * What a `/handoff` turns into before it is sent.
 *
 * A skill body is deliberately NOT inlined here: Pi's whole skills design is
 * progressive disclosure — name and description in the head, body loaded
 * with `read` only when it is needed — and pasting the file into the prompt
 * would throw that away and pay for every skill that is merely available.
 * So this is an instruction to go and read it, which is what Pi's own
 * `/skill:` form does.
 */
export function skillPrompt(name: string, args: string): string {
  const skill = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
  const where = skill?.filePath ? ` Its instructions are in ${skill.filePath} — read that file first.` : "";
  const withArgs = args.trim().length > 0 ? `

Arguments: ${args.trim()}` : "";
  return `Use the ${name} skill.${where} Follow it for this task.${withArgs}`;
}

/** Does Lykos recognise this command word (no leading slash)? False is what makes a typo visible in the composer. */
export function isOwnedName(word: string): boolean {
  const lower = word.toLowerCase();
  if (BUILTIN_BY_NAME.has(`/${lower}`)) return true;
  if (resolveSkillName(word) !== undefined) return true;
  if (resolveExtensionCommandName(word) !== undefined) return true;
  return resolvePiCommandName(word) !== undefined;
}
