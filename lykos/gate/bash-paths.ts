// T212 (issue #68, ADR-0042) — path rules reach file commands in bash and powershell.

import { basename } from "node:path";
import { splitShellSegments, tokenizeSegment } from "../loop/exploration.js";
import { decidePath, type PathAccess, type PathContext, type PathRule } from "./path-rules.js";

export interface CommandPathAccess {
  path: string;
  access: PathAccess;
}

export interface CommandPathsDecision {
  decision: "allow" | "ask" | "deny";
  rule?: string;
  reason?: string;
  protected?: boolean;
  covered: boolean;
}

const HARMLESS_TARGETS: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/zero",
  "/dev/stdin",
  "nul",
  "NUL",
]);

const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "time",
  "nohup",
  "command",
  "nice",
  "stdbuf",
  "env",
]);

/**
 * Cuts a line at an unquoted `#` that starts a word (after whitespace, the start of the line or
 * a command separator). `a#b`, `$#` and `${#x}` are not comments. A backslash escapes for bash
 * (outside quotes and inside double quotes) and is literal for PowerShell; the line is cut under
 * both readings and the longer result kept, so a `#` either shell sees inside a string never hides
 * what follows. A quote that never closes keeps the rest of the line.
 */
function stripComment(line: string): string {
  const bash = stripCommentAs(line, false);
  const literal = stripCommentAs(line, true);
  return bash.length >= literal.length ? bash : literal;
}

function stripCommentAs(line: string, literal: boolean): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === "\\" && !literal && quote !== "'") {
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch as '"' | "'";
      continue;
    }
    if (ch === "#") {
      const prev = i === 0 ? " " : line[i - 1]!;
      if (/[\s;|&(]/.test(prev)) return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Strips heredoc bodies from multi-line commands so that text within a heredoc body
 * is never scanned as shell commands (T212, Ruling 6).
 */
function stripHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/);
  const outLines: string[] = [];
  const pendingDelims: Array<{ delim: string; stripTabs: boolean }> = [];

  for (let line of lines) {
    if (pendingDelims.length > 0) {
      const top = pendingDelims[0]!;
      const checkLine = top.stripTabs ? line.replace(/^\t+/, "") : line;
      if (checkLine.trimEnd() === top.delim) {
        pendingDelims.shift();
      }
      // Heredoc body lines (and the delimiter line) are data, not commands.
      continue;
    }

    // A comment runs to the end of the line and names nothing (`# see <<TAG` is not a heredoc,
    // `cat a # .env` does not read .env).
    const code = stripComment(line);
    outLines.push(code);
    line = code;

    // Look for heredoc operators on this line: << or <<-
    // Ignore <<< (here-strings), << inside quotes and << in arithmetic.
    let quote: '"' | "'" | null = null;
    let i = 0;
    while (i < line.length) {
      const ch = line[i]!;
      if (quote) {
        if (ch === quote) quote = null;
        else if (quote === '"' && ch === "\\" && i + 1 < line.length) i += 1;
        i += 1;
        continue;
      }
      if (ch === "\\" && i + 1 < line.length) {
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch as '"' | "'";
        i += 1;
        continue;
      }

      // Arithmetic: `((...))` and `$((...))` hold shifts, not heredocs. Skip to the closing `))`.
      if (ch === "(" && line[i + 1] === "(") {
        const close = line.indexOf("))", i + 2);
        i = close === -1 ? line.length : close + 2;
        continue;
      }

      // Check for << (and not <<<)
      if (ch === "<" && line[i + 1] === "<") {
        if (line[i + 2] === "<") {
          // <<< here-string, skip past it
          i += 3;
          continue;
        }
        i += 2;
        let stripTabs = false;
        if (line[i] === "-") {
          stripTabs = true;
          i += 1;
        }
        while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
        let delim = "";
        let delimQuote: '"' | "'" | null = null;
        if (line[i] === "'" || line[i] === '"') {
          delimQuote = line[i] as '"' | "'";
          i += 1;
          while (i < line.length && line[i] !== delimQuote) {
            delim += line[i]!;
            i += 1;
          }
          if (i < line.length) i += 1;
        } else {
          while (
            i < line.length &&
            line[i] !== " " &&
            line[i] !== "\t" &&
            line[i] !== ";" &&
            line[i] !== "&" &&
            line[i] !== "|" &&
            line[i] !== ">" &&
            line[i] !== "<"
          ) {
            delim += line[i]!;
            i += 1;
          }
        }
        if (delim.length > 0) {
          pendingDelims.push({ delim, stripTabs });
        }
        continue;
      }

      i += 1;
    }
  }

  return outLines.join("\n");
}

function consumeShellToken(segment: string, start: number, literal = false): [string, number] {
  let token = "";
  let quote: '"' | "'" | null = null;
  let i = start;

  while (i < segment.length) {
    const ch = segment[i]!;

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === "\\" && !literal && i + 1 < segment.length) {
        token += segment[i + 1]!;
        i += 1;
      } else {
        token += ch;
      }
      i += 1;
      continue;
    }

    if (ch === "\\" && !literal) {
      if (i + 1 < segment.length) {
        token += segment[i + 1]!;
        i += 1;
      }
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch as '"' | "'";
      i += 1;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === ">" || ch === "<" || ch === "|" || ch === "&" || ch === ";") {
      break;
    }

    token += ch;
    i += 1;
  }

  return [token, i];
}

function extractRedirectsAndCleanSegment(segment: string, literal = false): {
  cleanedSegment: string;
  redirects: CommandPathAccess[];
} {
  const redirects: CommandPathAccess[] = [];
  let cleaned = "";
  let quote: '"' | "'" | null = null;
  let i = 0;

  while (i < segment.length) {
    const ch = segment[i]!;

    if (quote) {
      cleaned += ch;
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === "\\" && !literal && i + 1 < segment.length) {
        cleaned += segment[i + 1]!;
        i += 1;
      }
      i += 1;
      continue;
    }

    if (ch === "\\" && !literal) {
      cleaned += ch;
      if (i + 1 < segment.length) {
        cleaned += segment[i + 1]!;
        i += 1;
      }
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch as '"' | "'";
      cleaned += ch;
      i += 1;
      continue;
    }

    // Check here-strings: <<< (Ruling 6: a here-string is not a path)
    if (ch === "<" && segment[i + 1] === "<" && segment[i + 2] === "<") {
      i += 3;
      while (i < segment.length && (segment[i] === " " || segment[i] === "\t")) i += 1;
      const [_, nextI] = consumeShellToken(segment, i, literal);
      i = nextI;
      continue;
    }

    // Check heredoc operators: << or <<-
    if (ch === "<" && segment[i + 1] === "<") {
      i += 2;
      if (segment[i] === "-") i += 1;
      while (i < segment.length && (segment[i] === " " || segment[i] === "\t")) i += 1;
      const [_, nextI] = consumeShellToken(segment, i, literal);
      i = nextI;
      continue;
    }

    // Check redirect operators: > or <
    if (ch === ">" || ch === "<") {
      // Look back in `cleaned` for attached file descriptor or `&`: e.g. 2>, 1>, &>
      // Only a bare number (or `&`) directly before the operator is a descriptor; the digits
      // that end a filename (`.env2>out`) belong to the word.
      let j = cleaned.length - 1;
      while (j >= 0 && cleaned[j]! >= "0" && cleaned[j]! <= "9") j -= 1;
      const digits = j < cleaned.length - 1;
      if (!digits && j >= 0 && cleaned[j] === "&") j -= 1;
      const wordStart = j < 0 || cleaned[j] === " " || cleaned[j] === "\t";
      if ((digits || j < cleaned.length - 1) && wordStart) cleaned = cleaned.slice(0, j + 1);

      let op = ch;
      i += 1;
      if (op === ">" && segment[i] === ">") {
        op = ">>";
        i += 1;
      }

      while (i < segment.length && (segment[i] === " " || segment[i] === "\t")) i += 1;

      // `>&N` / `>&-` duplicate or close a descriptor and name no path; `>&file` writes the file.
      let dup = false;
      if (op !== "<" && segment[i] === "&") {
        dup = true;
        i += 1;
      }
      const [target, nextI] = consumeShellToken(segment, i, literal);
      i = nextI;

      if (dup && /^(\d+|-)$/.test(target)) {
        continue;
      }

      // Harmless targets (/dev/null, etc.) contribute nothing
      if (HARMLESS_TARGETS.has(target)) {
        continue;
      }

      if (target.length > 0) {
        redirects.push({
          path: target,
          access: op === "<" ? "read" : "write",
        });
      }

      continue;
    }

    cleaned += ch;
    i += 1;
  }

  return { cleanedSegment: cleaned, redirects };
}

function unwrapCommandTokens(tokens: readonly string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      i += 1;
      continue;
    }
    const base = basename(tok).toLowerCase().replace(/\.exe$/, "");
    if (TRANSPARENT_WRAPPERS.has(base)) {
      i += 1;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        i += 1;
      }
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/**
 * Splits a segment into words with a backslash kept as an ordinary character (PowerShell, and
 * a Windows path typed into any shell). Quotes group; a PowerShell backtick escapes the next
 * character outside single quotes.
 */
function tokenizeLiteral(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === "`" && i + 1 < segment.length) {
        i += 1;
        current += segment[i]!;
      } else current += ch;
      continue;
    }
    if (ch === "`" && i + 1 < segment.length) {
      i += 1;
      current += segment[i]!;
      started = true;
    } else if (ch === "'" || ch === '"') {
      quote = ch as '"' | "'";
      started = true;
    } else if (ch === " " || ch === "\t") {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Extracts paths named by recognized file commands in bash and powershell,
 * as well as `>`, `>>`, and `<` redirect targets.
 *
 * A segment that contains a backslash is read twice: once as bash (backslash escapes) and once
 * with the backslash literal, because PowerShell and a Windows path use it as a separator and the
 * scanner does not know which shell will run the command. Both readings are checked.
 */
export function commandPathAccesses(command: string): CommandPathAccess[] {
  const stripped = stripHeredocBodies(command);
  const segments = splitShellSegments(stripped);
  const accesses: CommandPathAccess[] = [];

  for (const seg of segments) {
    scanSegment(seg, false, accesses);
    if (seg.includes("\\")) scanSegment(seg, true, accesses);
  }

  const seen = new Set<string>();
  return accesses.filter((a) => {
    const key = `${a.access}\0${a.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scanSegment(seg: string, literal: boolean, accesses: CommandPathAccess[]): void {
  {
    const { cleanedSegment, redirects } = extractRedirectsAndCleanSegment(seg, literal);
    accesses.push(...redirects);

    const rawTokens = literal ? tokenizeLiteral(cleanedSegment) : tokenizeSegment(cleanedSegment);
    const tokens = unwrapCommandTokens(rawTokens);
    if (tokens.length === 0) return;

    const head = basename(tokens[0]!).toLowerCase().replace(/\.exe$/, "");

    if (head === "cat") {
      let endOfOptions = false;
      for (let idx = 1; idx < tokens.length; idx++) {
        const tok = tokens[idx]!;
        if (!endOfOptions) {
          if (tok === "--") {
            endOfOptions = true;
            continue;
          }
          if (tok.startsWith("-") && tok !== "-") {
            continue;
          }
        }
        if (tok !== "-") {
          accesses.push({ path: tok, access: "read" });
        }
      }
    } else if (head === "head") {
      let endOfOptions = false;
      let idx = 1;
      while (idx < tokens.length) {
        const tok = tokens[idx]!;
        if (!endOfOptions) {
          if (tok === "--") {
            endOfOptions = true;
            idx += 1;
            continue;
          }
          if (tok === "-n" || tok === "-c" || tok === "--lines" || tok === "--bytes") {
            idx += 2;
            continue;
          }
          if (
            tok.startsWith("-n") ||
            tok.startsWith("-c") ||
            tok.startsWith("--lines=") ||
            tok.startsWith("--bytes=")
          ) {
            idx += 1;
            continue;
          }
          if (tok.startsWith("-") && tok !== "-") {
            idx += 1;
            continue;
          }
        }
        if (tok !== "-") {
          accesses.push({ path: tok, access: "read" });
        }
        idx += 1;
      }
    } else if (head === "tail") {
      let endOfOptions = false;
      let idx = 1;
      while (idx < tokens.length) {
        const tok = tokens[idx]!;
        if (!endOfOptions) {
          if (tok === "--") {
            endOfOptions = true;
            idx += 1;
            continue;
          }
          if (
            tok === "-n" ||
            tok === "-c" ||
            tok === "-s" ||
            tok === "--lines" ||
            tok === "--bytes" ||
            tok === "--sleep-interval" ||
            tok === "--pid"
          ) {
            idx += 2;
            continue;
          }
          if (
            tok.startsWith("-n") ||
            tok.startsWith("-c") ||
            tok.startsWith("-s") ||
            tok.startsWith("--lines=") ||
            tok.startsWith("--bytes=") ||
            tok.startsWith("--sleep-interval=") ||
            tok.startsWith("--pid=")
          ) {
            idx += 1;
            continue;
          }
          if (tok.startsWith("+")) {
            idx += 1;
            continue;
          }
          if (tok.startsWith("-") && tok !== "-") {
            idx += 1;
            continue;
          }
        }
        if (tok !== "-") {
          accesses.push({ path: tok, access: "read" });
        }
        idx += 1;
      }
    } else if (head === "sed") {
      // Ruling 5: Every in-place form counts as a write: -i, -i.bak, -i'' , combined short flags containing i (e.g. -ni), --in-place, --in-place=SUFFIX.
      const isInPlace = tokens.slice(1).some(
        (tok) =>
          tok.startsWith("--in-place") ||
          (tok.startsWith("-") && !tok.startsWith("--") && tok.includes("i")),
      );

      let hasScript = false;
      let endOfOptions = false;
      let idx = 1;

      while (idx < tokens.length) {
        const tok = tokens[idx]!;

        if (!endOfOptions) {
          if (tok === "--") {
            endOfOptions = true;
            idx += 1;
            continue;
          }

          if (tok === "-e" || tok === "--expression" || tok === "-f" || tok === "--file") {
            hasScript = true;
            idx += 2;
            continue;
          }
          if (
            tok.startsWith("-e") ||
            tok.startsWith("--expression=") ||
            tok.startsWith("-f") ||
            tok.startsWith("--file=")
          ) {
            hasScript = true;
            idx += 1;
            continue;
          }

          // BSD sed -i '' or -i .bak with separate suffix argument
          if (tok === "-i" && idx + 1 < tokens.length) {
            const next = tokens[idx + 1]!;
            if (next === "" || next.startsWith(".")) {
              idx += 2;
              continue;
            }
          }

          if (tok.startsWith("-")) {
            idx += 1;
            continue;
          }
        }

        // First non-option is the script if not specified by -e or -f
        if (!hasScript) {
          hasScript = true;
          idx += 1;
          continue;
        }

        if (tok !== "-") {
          accesses.push({ path: tok, access: isInPlace ? "write" : "read" });
        }
        idx += 1;
      }
    } else if (head === "tee") {
      let endOfOptions = false;
      for (let idx = 1; idx < tokens.length; idx++) {
        const tok = tokens[idx]!;
        if (!endOfOptions) {
          if (tok === "--") {
            endOfOptions = true;
            continue;
          }
          if (tok.startsWith("-") && tok !== "-") {
            continue;
          }
        }
        if (tok !== "-") {
          accesses.push({ path: tok, access: "write" });
        }
      }
    } else if (head === "get-content" || head === "gc" || head === "type") {
      // PowerShell read cmdlets/aliases (Ruling 1)
      let idx = 1;
      while (idx < tokens.length) {
        const tok = tokens[idx]!;
        if (tok.startsWith("-")) {
          const lower = tok.toLowerCase();
          if (lower === "-path" || lower === "-literalpath") {
            idx += 1;
            if (idx < tokens.length) {
              const val = tokens[idx]!;
              for (const p of val.split(",")) {
                const trimmed = p.trim();
                if (trimmed.length > 0) accesses.push({ path: trimmed, access: "read" });
              }
            }
            idx += 1;
            continue;
          }
          if (
            lower === "-totalcount" ||
            lower === "-head" ||
            lower === "-tail" ||
            lower === "-encoding" ||
            lower === "-delimiter" ||
            lower === "-filter"
          ) {
            idx += 2;
            continue;
          }
          idx += 1;
          continue;
        }
        for (const p of tok.split(",")) {
          const trimmed = p.trim();
          if (trimmed.length > 0) accesses.push({ path: trimmed, access: "read" });
        }
        idx += 1;
      }
    } else if (
      head === "set-content" ||
      head === "sc" ||
      head === "add-content" ||
      head === "ac" ||
      head === "out-file"
    ) {
      // PowerShell write cmdlets/aliases (Ruling 1). Only the path is a path: the first positional
      // operand, unless -Path/-LiteralPath/-FilePath names it. Later positionals are the data
      // (Set-Content -Value) or an encoding, and -Value's own operand is skipped.
      let idx = 1;
      let pathGiven = false;
      let positional = 0;
      while (idx < tokens.length) {
        const tok = tokens[idx]!;
        if (tok.startsWith("-")) {
          const lower = tok.toLowerCase();
          if (lower === "-path" || lower === "-literalpath" || lower === "-filepath") {
            pathGiven = true;
            idx += 1;
            if (idx < tokens.length) {
              const val = tokens[idx]!;
              for (const p of val.split(",")) {
                const trimmed = p.trim();
                if (trimmed.length > 0) accesses.push({ path: trimmed, access: "write" });
              }
            }
            idx += 1;
            continue;
          }
          if (
            lower === "-encoding" ||
            lower === "-width" ||
            lower === "-value" ||
            lower === "-filter"
          ) {
            idx += 2;
            continue;
          }
          idx += 1;
          continue;
        }
        positional += 1;
        if (positional === 1 && !pathGiven) {
          for (const p of tok.split(",")) {
            const trimmed = p.trim();
            if (trimmed.length > 0) accesses.push({ path: trimmed, access: "write" });
          }
        }
        idx += 1;
      }
    }
  }
}

/**
 * Expands leading ~/ or $HOME/ to ctx.home before decidePath (T212, Ruling 3).
 */
function expandHome(path: string, home: string): string {
  const normHome = home.replace(/[\\/]+$/, "");
  if (path === "~") return normHome;
  if (path.startsWith("~/")) return `${normHome}/${path.slice(2)}`;
  if (path === "$HOME" || path === "${HOME}") return normHome;
  if (path.startsWith("$HOME/")) return `${normHome}/${path.slice(6)}`;
  if (path.startsWith("${HOME}/")) return `${normHome}/${path.slice(8)}`;
  if (path.startsWith("~\\")) return `${normHome}/${path.slice(2)}`;
  if (path.startsWith("$HOME\\")) return `${normHome}/${path.slice(6)}`;
  return path;
}

/**
 * Decides whether the paths named in a command are permitted by the path rules.
 * Strictest verdict wins (deny > ask > allow).
 */
export function decideCommandPaths(
  command: string,
  rules: readonly PathRule[],
  ctx: PathContext,
): CommandPathsDecision {
  const accesses = commandPathAccesses(command);
  if (accesses.length === 0) {
    return { decision: "allow", covered: false };
  }

  let bestVerdict: "allow" | "ask" | "deny" = "allow";
  let bestRule: string | undefined;
  let bestReason: string | undefined;
  let isProtected = false;

  for (const { path, access } of accesses) {
    const target = expandHome(path, ctx.home);
    const verdict = decidePath(target, access, rules, ctx);

    if (verdict.decision === "deny") {
      bestVerdict = "deny";
      bestRule = verdict.rule;
      bestReason = verdict.reason;
      if (verdict.protected) isProtected = true;
      break;
    } else if (verdict.decision === "ask") {
      bestVerdict = "ask";
      bestRule = verdict.rule ?? bestRule;
      bestReason = verdict.reason ?? bestReason;
      if (verdict.protected) isProtected = true;
    } else if (verdict.decision === "allow") {
      if (bestVerdict === "allow") {
        bestRule = verdict.rule ?? bestRule;
      }
    }
  }

  return {
    decision: bestVerdict,
    ...(bestRule !== undefined ? { rule: bestRule } : {}),
    ...(bestReason !== undefined ? { reason: bestReason } : {}),
    ...(isProtected ? { protected: true } : {}),
    covered: true,
  };
}

/**
 * Path rule enforcement guarantee: enforced under containment and best effort on the host.
 */
export function pathRuleEnforcement(contained: boolean): "enforced" | "best effort" {
  return contained ? "enforced" : "best effort";
}
