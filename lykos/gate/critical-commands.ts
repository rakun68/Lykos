// P10.8, ticket 11 — the shapes a head-of-segment classifier cannot see.
//
// `command-safety.ts` decides what a command is by splitting it into
// segments and reading each segment's head. That structure is the better of
// the two designs and it stays: it understands chains, quoting, wrappers and
// env assignments, and it does so through the one parser in
// `loop/exploration.ts` rather than a second opinion.
//
// What it cannot see is everything that is not a head. A redirect target is
// not a head. A shell function definition has no head. A command inside a
// process substitution is not a head of the outer command. A flag on a
// command whose head is otherwise ordinary is not a head. Seven catastrophic
// shapes get through for exactly that reason, and each of them is a shape
// that is virtually never legitimate in automation.
//
// **Only the shapes that close a real gap are listed.** `sudo rm`, `mkfs`,
// `dd if=…of=/dev/…`, `shred /dev/…`, `shutdown`, `chmod -R … /` and
// `curl … | sh` are already `destructive` here through `ALWAYS_DESTRUCTIVE`,
// the recursive-removal branch, or `pipesNetworkIntoShell`. Listing them
// again would put two rules on the same question, and two rules drift apart.

/**
 * Whole-command patterns. Each is matched against the raw command line
 * before segmentation, because the information each one needs is not in any
 * segment's head.
 *
 * `label` exists so a test names the shape it is guarding rather than an
 * index into an array, and so a future approval surface can say which rule
 * fired.
 */
export interface CriticalCommandPattern {
  /** The shape, in the words the ticket uses. */
  label: string;
  /** The whole-command regular expression. */
  pattern: RegExp;
}

export const CRITICAL_COMMAND_PATTERNS: readonly CriticalCommandPattern[] = [
  {
    label: "rm --no-preserve-root",
    // `--no-preserve-root` defeats coreutils' own refusal to recurse on `/`, so it is critical
    // wherever it appears — including forms this list would otherwise reach only via the target.
    pattern: /\brm\s+(?:-\S+\s+)*--no-preserve-root\b/i,
  },
  {
    label: "fork bomb",
    // Fork bomb (a few common spacings).
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:/i,
  },
  {
    label: "write to a raw disk device",
    pattern: />\s*\/dev\/sd[a-z]/i, // write to disk device.
  },
  {
    label: "redirect over /etc/passwd, /etc/shadow or /etc/sudoers",
    pattern: />\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
  },
  {
    label: "tee into /etc/passwd, /etc/shadow or /etc/sudoers",
    pattern: /\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i, // `tee /etc/passwd`, `tee -a /etc/sudoers`.
  },
  {
    label: "fetch then execute through process substitution",
    // Process-sub variants — `bash <(curl …)`, `source <(curl …)`, `. <(curl …)`. `.` and `source` are
    // anchored to a command boundary so `find . -name` and similar don't false-positive.
    pattern: /(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
  },
  {
    label: "fetch then execute through eval",
    // `eval "$(curl …)"` / `eval $(curl …)` / `eval \`curl …\``.
    pattern: /\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,
  },
  {
    label: "netcat with a command",
    pattern: /\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i, // `nc -e` / `nc -c`.
  },
  {
    label: "kill PID 1",
    // Known false positive, recorded rather than patched: this matches the
    // words wherever they appear, including inside a quoted string, so
    // `echo 'kill -9 1 is dangerous' >> notes.md` is classified destructive
    // and prompts. Tightening it would mean owning a rule that has diverged
    // from the one it was copied from, and the value of a verbatim copy is
    // that it is the tested upstream text. A false positive costs one
    // approval prompt; a false negative costs the host.
    pattern: /\bkill\s+-9\s+1\b/, // kill PID 1.
  },
] as const;

/**
 * Does this command match a copied critical row?
 *
 * Returns the label of the first match so a caller can say which one, and
 * `undefined` when nothing matched. It never says "safe" — a command no row
 * matches still goes through the structural classifier, which is where the
 * ordinary answer comes from.
 */
export function matchCriticalCommand(command: string): string | undefined {
  for (const row of CRITICAL_COMMAND_PATTERNS) {
    if (row.pattern.test(command)) return row.label;
  }
  return undefined;
}
