// `lykos status`, `lykos wait`, `lykos stop` (T243): thin front ends over the delegation core. They read and write
// the project ledger, so they see every delegated session of the project, whichever process owns it (`lykos run`
// or an MCP server). Every command prints JSON with `next`; no arguments prints its usage; an unknown flag is an
// error (R19).

import { ledgerViews, stopElsewhere, waitForSessions } from "../delegate/mcp-server.js";
import type { SessionView } from "../delegate/ownership.js";
import { stdoutWrite } from "../tui/io-mode.js";

export interface ParsedFlags {
  ids: string[];
  flags: Map<string, string | true>;
}

/** Splits arguments into ids and flags; an unknown flag is an error that names the known ones. */
export function parseFlags(args: readonly string[], command: string, valued: readonly string[], booleans: readonly string[]): ParsedFlags | { error: string } {
  const ids: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      ids.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (valued.includes(name)) {
      const value = eq !== -1 ? arg.slice(eq + 1) : args[i + 1];
      if (value === undefined || (eq === -1 && value.startsWith("--"))) return { error: `lykos ${command}: --${name} needs a value` };
      if (eq === -1) i += 1;
      flags.set(name, value);
    } else if (booleans.includes(name) && eq === -1) {
      flags.set(name, true);
    } else {
      const known = [...valued.map((v) => `--${v} <value>`), ...booleans.map((b) => `--${b}`)];
      return { error: `lykos ${command}: unknown flag ${arg}${known.length > 0 ? ` (known: ${known.join(", ")})` : " (it takes none)"}` };
    }
  }
  return { ids, flags };
}

function print(value: unknown): void {
  stdoutWrite(`${JSON.stringify(value, null, 2)}\n`);
}

/** The one `next` a list of sessions asks for: a crash first, then a question, then a wait, then the first result's. */
export function nextOf(views: readonly SessionView[]): string {
  for (const want of ["recover", "answer_question"]) if (views.some((v) => v.next === want)) return want;
  if (views.some((v) => v.state === "running" || v.state === "waiting")) return "wait";
  return views.find((v) => v.next !== undefined)?.next ?? "review_or_accept";
}

export const STATUS_USAGE = "usage: lykos status <session-id>... | --all    the sessions' state, owner and result, from the project ledger";
export const WAIT_USAGE = "usage: lykos wait <session-id>... [--any] [--timeout <seconds>]    block until the sessions end (or one, with --any)";
export const STOP_USAGE = "usage: lykos stop <session-id>    ask the session's owner to stop it, and wait up to 10 s for it to end";

function usage(line: string): number {
  stdoutWrite(`${line}\n`);
  return 2;
}

function missing(ids: readonly string[], views: readonly SessionView[]): string[] {
  const known = new Set(views.map((v) => v.session_id));
  return ids.filter((id) => !known.has(id));
}

export function runStatus(cwd: string, args: readonly string[]): number {
  if (args.length === 0) return usage(STATUS_USAGE);
  const parsed = parseFlags(args, "status", [], ["all"]);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const all = parsed.flags.has("all");
  if (all === (parsed.ids.length > 0)) {
    process.stderr.write("lykos status: give session ids or --all, not both\n");
    return 1;
  }
  const views = ledgerViews(cwd, all ? undefined : parsed.ids);
  const unknown = all ? [] : missing(parsed.ids, views);
  if (unknown.length > 0) {
    print({ outcome: "error", message: `unknown session id: ${unknown.join(", ")}`, sessions: views, next: "fix_environment" });
    return 1;
  }
  print({ sessions: views, next: views.length === 0 ? "run" : nextOf(views) });
  return 0;
}

export async function runWait(cwd: string, args: readonly string[]): Promise<number> {
  if (args.length === 0) return usage(WAIT_USAGE);
  const parsed = parseFlags(args, "wait", ["timeout"], ["any"]);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  if (parsed.ids.length === 0) return usage(WAIT_USAGE);
  const timeoutRaw = parsed.flags.get("timeout");
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    const seconds = Number(timeoutRaw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      process.stderr.write(`lykos wait: --timeout must be a positive number of seconds, got "${String(timeoutRaw)}"\n`);
      return 1;
    }
    timeoutMs = seconds * 1000;
  }
  const unknown = missing(parsed.ids, ledgerViews(cwd, parsed.ids));
  if (unknown.length > 0) {
    print({ outcome: "error", message: `unknown session id: ${unknown.join(", ")}`, next: "fix_environment" });
    return 1;
  }
  const views = await waitForSessions(cwd, parsed.ids, parsed.flags.has("any"), timeoutMs);
  print({ sessions: views, next: nextOf(views) });
  return 0;
}

export async function runStop(cwd: string, args: readonly string[]): Promise<number> {
  if (args.length === 0) return usage(STOP_USAGE);
  const parsed = parseFlags(args, "stop", [], []);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  if (parsed.ids.length !== 1) return usage(STOP_USAGE);
  const id = parsed.ids[0]!;
  const stopped = await stopElsewhere(cwd, id);
  if (stopped === undefined) {
    print({ outcome: "error", message: `unknown session id: ${id}`, next: "fix_environment" });
    return 1;
  }
  print({ ...stopped, next: stopped.next ?? (stopped.state === "running" || stopped.state === "waiting" ? "wait" : "review_or_accept") });
  return 0;
}
