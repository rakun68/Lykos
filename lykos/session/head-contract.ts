// The cache-stable head contract.
//
// Three rules, in force from session boot. Scope is what T16.1 recorded as
// controllable without patching Pi (`docs/11-prefix-control-surface.md`):
//
//   T17.1  Deterministic assembly. System prompt, rules, and tool schemas
//          in a fixed, explicitly-specified order, with zero volatile
//          content. Anything that must vary goes on the tail, never here.
//   T17.2  Boot-once injection. Environment summary, tool schemas, and
//          project fingerprint are computed once at session start and
//          never regenerated. Anything that cannot be fixed at boot does
//          not belong in the head at all.
//   T17.3  Append-only after boot. Nothing already in the head is mutated,
//          reordered, or regenerated for the life of the session.
//
// Division of labor with `pi-cache-optimizer` (T16.1a): that extension owns
// *mutation* of Pi's assembled prompt (strip churn, reorder stable content).
// This module owns the *discipline* of what Lykos itself puts in the head
// via `appendSystemPromptOverride` — a frozen string, closed over at
// DefaultResourceLoader construction, never rewritten. Lykos's head blocks
// do not register a competing `before_agent_start` mutator. The one Lykos
// code that does is the `lykos-repo-map` default extension (T148), which is a
// Pi extension on purpose and appends the same frozen bytes on every turn.
//
// A unit test of this function is a unit test of what T16.2 stores.

import { createHash } from "node:crypto";

/**
 * Explicit assembly order of the Lykos-owned boot block. Changing this
 * mid-session is a prefix break; changing it between sessions is a new
 * contract version and belongs in DECISIONS.md, not in a quiet edit.
 */
export const HEAD_FIELD_ORDER = ["cwd", "platform", "project", "git_head", "tools"] as const;

export type HeadField = (typeof HEAD_FIELD_ORDER)[number];

/** Frozen at session start. Every field is a value captured once, never re-read. */
export interface BootArtifacts {
  cwd: string;
  platform: string;
  /** Stable project identifier — basename of cwd, not a live git status. */
  project: string;
  /** `git rev-parse HEAD` at boot, or `"no-git"`. Captured once. */
  gitHeadAtBoot: string;
  /** Caller-ordered tool names, preserved verbatim. Empty means Pi's own default. */
  toolNames: readonly string[];
}

export type VolatileKind =
  | "timestamp"
  | "session-overview"
  | "git-status"
  | "git-branch"
  | "lykos-volatile-inject";

export interface ObserveResult {
  fingerprint: string;
  changed: boolean;
  driftedFields: string[];
  volatile: VolatileKind[];
}

export const BOOT_HEADING = "## lykos-head";

/**
 * Fixes the "who are you?" bug filed 2026-09-01: with no identity block,
 * self-identification fell through to Pi's own base system prompt, which
 * names itself "Pi." Frozen and unconditional — every other block in this
 * file is either boot-derived (`bootHead`) or flag-gated (T21/T23's diet
 * blocks); this one is neither, so it lives here rather than in
 * `prompt-diet.ts`, and `buildAppendSystemPromptOverride()` (`session/boot.ts`)
 * appends it on every session with no `LYKOS_*` opt-out.
 */
export const IDENTITY_HEADING = "## lykos-identity";

export function assembleIdentityHead(): string {
  return [
    IDENTITY_HEADING,
    'You are Lykos, a cost-aware coding agent built on Pi. If asked who or what you are, answer as Lykos, not as "Pi" — Pi is the underlying agent runtime, not your name.',
  ].join("\n");
}

const BOOT_FIELD_LINE = /^(cwd|platform|project|git_head|tools): (.*)$/;

/**
 * T17.1: assemble the Lykos-owned boot block in `HEAD_FIELD_ORDER`. Pure.
 * No clock, no env read, no re-sort of `toolNames`. The caller is responsible
 * for passing values that were captured once at boot (T17.2).
 */
export function bootFieldValues(artifacts: BootArtifacts): Record<HeadField, string> {
  const tools =
    artifacts.toolNames.length === 0 ? "(pi-default)" : artifacts.toolNames.join(",");
  return {
    cwd: artifacts.cwd,
    platform: artifacts.platform,
    project: artifacts.project,
    git_head: artifacts.gitHeadAtBoot,
    tools,
  };
}

export function assembleBootHead(artifacts: BootArtifacts): string {
  const lines = bootFieldValues(artifacts);
  return [BOOT_HEADING, ...HEAD_FIELD_ORDER.map((field) => `${field}: ${lines[field]}`)].join("\n");
}

/**
 * Parse the `## lykos-head` block out of an observed system prompt.
 * Returns null when the block is missing or any documented field is absent —
 * that is `bootHead` drift, not a guessed partial.
 */
/**
 * T90: the Lykos-owned region of an observed system prompt.
 *
 * The volatile scan must run on what Lykos put there, not on the whole
 * prompt. Pi's own base prompt and the ingested context files
 * (`AGENTS.md`, `CLAUDE.md`) are appended around it, Lykos does not control
 * their text, and a project whose CLAUDE.md merely *mentions* `git status`
 * is not a project whose head churns.
 *
 * Found by the Phase 15 sweep: this repository's own CLAUDE.md contains the
 * phrase "git status" (in T66's finding about repeated commands), so every
 * standalone session against this repo printed
 * `lykos head-drift (standalone): changed field(s): volatile:git-status`
 * on every turn while its prefix was in fact perfectly stable — the same
 * session reported a 75.6% cache-read ratio, which is only possible if the
 * head never moved. A detector that cries wolf on a stable head is worse
 * than no detector: T18 exists so real drift is noticed, and noise is how
 * real drift stops being noticed.
 *
 * Returns the whole prompt when no boot block is present, so a session with
 * no Lykos head is still scanned rather than silently exempted.
 */
export function lykosOwnedRegion(systemPrompt: string): string {
  const start = systemPrompt.indexOf(BOOT_HEADING);
  if (start < 0) return systemPrompt;
  // Lykos's blocks are contiguous from the boot heading. The context files
  // Pi appends arrive under its own `<project_context>` wrapper; anything
  // before the boot heading is Pi's base prompt.
  const ctx = systemPrompt.indexOf("<project_context>", start);
  return ctx < 0 ? systemPrompt.slice(start) : systemPrompt.slice(start, ctx);
}

export function parseBootFields(systemPrompt: string): Record<HeadField, string> | null {
  const start = systemPrompt.indexOf(BOOT_HEADING);
  if (start < 0) return null;
  const rest = systemPrompt.slice(start + BOOT_HEADING.length).replace(/^\r?\n/, "");
  const out: Partial<Record<HeadField, string>> = {};
  for (const line of rest.split("\n")) {
    if (line.startsWith("#") || line === "") break;
    const m = BOOT_FIELD_LINE.exec(line);
    if (!m) break;
    out[m[1] as HeadField] = m[2] ?? "";
  }
  for (const field of HEAD_FIELD_ORDER) {
    if (out[field] === undefined) return null;
  }
  return out as Record<HeadField, string>;
}

/**
 * Byte-identical to `PiWorker.headFingerprint()` in the patched worker.
 * Hash the observed head (system prompt + ordered tool names), not a catalog
 * reconstruction. A NUL separator keeps the two halves from colliding.
 */
export function fingerprintHead(systemPrompt: string, toolNames: readonly string[]): string {
  return createHash("sha256")
    .update(systemPrompt)
    .update("\0")
    .update(toolNames.join(","))
    .digest("hex");
}

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const SESSION_OVERVIEW = /<session-overview\b/i;
const GIT_STATUS = /\bgit status\b/i;
const GIT_BRANCH = /\bgit branch\b/i;

/**
 * Kinds of churn T16.1 found in the wild (and the test-only injector T17
 * uses to demonstrate the negative direction). A frozen `git_head:` SHA in
 * the boot block is *not* volatile — it is a hex string, not a clock.
 */
export function detectVolatile(text: string): VolatileKind[] {
  const found: VolatileKind[] = [];
  if (SESSION_OVERVIEW.test(text)) found.push("session-overview");
  if (text.includes("[lykos-volatile ")) found.push("lykos-volatile-inject");
  if (ISO_TIMESTAMP.test(text)) found.push("timestamp");
  if (GIT_STATUS.test(text)) found.push("git-status");
  if (GIT_BRANCH.test(text)) found.push("git-branch");
  return found;
}

function toolNamesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((name, i) => name === b[i]);
}

/**
 * One session's head contract. `boot()` freezes the artifacts; `observe()`
 * compares later calls against that freeze. `rebase()` is refused — that is
 * T17.3, and the refusal is the test that a "small improvement" mid-session
 * cannot quietly land.
 */
export class HeadContract {
  private artifacts: BootArtifacts | undefined;
  private bootHead: string | undefined;
  private lastFingerprint: string | undefined;

  get booted(): boolean {
    return this.artifacts !== undefined;
  }

  boot(artifacts: BootArtifacts): { bootHead: string; fingerprint: string } {
    if (this.artifacts !== undefined) {
      throw new Error(
        "lykos head-contract: already booted — refusing to regenerate the head (T17.3 append-only)",
      );
    }
    const bootHead = assembleBootHead(artifacts);
    const volatile = detectVolatile(bootHead);
    if (volatile.length > 0) {
      throw new Error(
        `lykos head-contract: boot block contains volatile content (${volatile.join(", ")}) — T17.1 forbids it`,
      );
    }
    this.artifacts = {
      cwd: artifacts.cwd,
      platform: artifacts.platform,
      project: artifacts.project,
      gitHeadAtBoot: artifacts.gitHeadAtBoot,
      toolNames: [...artifacts.toolNames],
    };
    this.bootHead = bootHead;
    // Fingerprint of the boot block alone — useful as a handle, not as the
    // session's T16.2 fingerprint. That one is of the *full* observed head
    // and is recorded on the first observe(), matching
    // prefix_fingerprint_changed's "first call in the session is 0".
    return { bootHead, fingerprint: fingerprintHead(bootHead, this.artifacts.toolNames) };
  }

  /**
   * Compare this call's observed head against the freeze. Does not mutate
   * the freeze (T17.3). `changed` is false on the first observe (no prior
   * full-head fingerprint) and on every later call whose head matches.
   */
  observe(systemPrompt: string, toolNames: readonly string[]): ObserveResult {
    if (this.artifacts === undefined || this.bootHead === undefined) {
      throw new Error("lykos head-contract: observe() before boot()");
    }
    const fingerprint = fingerprintHead(systemPrompt, toolNames);
    const driftedFields: string[] = [];
    if (!toolNamesEqual(this.artifacts.toolNames, toolNames)) driftedFields.push("toolNames");
    if (!systemPrompt.includes(this.bootHead)) {
      const expected = bootFieldValues(this.artifacts);
      const observed = parseBootFields(systemPrompt);
      if (observed === null) {
        driftedFields.push("bootHead");
      } else {
        for (const field of HEAD_FIELD_ORDER) {
          if (observed[field] !== expected[field]) driftedFields.push(field);
        }
        if (!driftedFields.some((f) => f !== "toolNames")) driftedFields.push("bootHead");
      }
    }
    // T90: scan only what Lykos owns. See `lykosOwnedRegion` — scanning the
    // whole prompt made this fire on every turn for any repo whose context
    // files merely mention `git status`.
    const volatile = detectVolatile(lykosOwnedRegion(systemPrompt));
    if (volatile.length > 0) driftedFields.push(...volatile.map((k) => `volatile:${k}`));

    const changed = this.lastFingerprint !== undefined && this.lastFingerprint !== fingerprint;
    this.lastFingerprint = fingerprint;
    return { fingerprint, changed, driftedFields, volatile };
  }

  /** T17.3: there is no legal way to rebuild the head. */
  rebase(_artifacts: BootArtifacts): never {
    throw new Error(
      "lykos head-contract: rebase() refused — a mid-session head rewrite costs a full cache write on every subsequent call (T17.3)",
    );
  }
}
