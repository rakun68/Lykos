import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXPLORE_METRIC_VERSION,
  classifyBashCommand,
  classifyShellSegment,
  classifyToolCall,
  exploreShare,
  serializeBreakdown,
  splitShellSegments,
  summarizeExploration,
  tokenizeSegment,
} from "./exploration.js";

/**
 * T63's fixtures are the archive's own commands, not invented ones. Every
 * string in ARCHIVE_COMMANDS was read out of `.lykos/session/*[/]transcript.jsonl`
 * on 2026-09-03 — the 26 `bash` calls that recorded their `args.command`.
 * `docs/20-phase9-tasks.md` §2 says a classifier wrong in either direction
 * makes T67's gate lie, so the table is the real workload.
 */
const ARCHIVE_COMMANDS: ReadonlyArray<{ command: string; expect: "explore" | "other"; why: string }> = [
  {
    command: "cd /c/Workspace/Projects/Lykos && ls lykos/cli/ && cat lykos/cli/index.ts 2>/dev/null | head -50",
    expect: "explore",
    why: "cd is neutral; ls/cat/head all explore; 2>/dev/null is not a write",
  },
  {
    command: 'cd /c/Workspace/Projects/Lykos && ls lykos/cli/ && grep -rn "sessions" lykos/cli/*.ts | head -20',
    expect: "explore",
    why: "the canonical post-T20 search, invisible to the v1 counter",
  },
  {
    command:
      'cd /c/Workspace/Projects/Lykos && ls .lykos/session/ 2>/dev/null | head; echo ---; grep -n "sessions" lykos/cli/*.ts docs/05-cli-and-config.md 2>/dev/null | head -30',
    expect: "explore",
    why: "echo as a separator must not disqualify the chain",
  },
  {
    command: 'curl -s --max-time 15 "https://wttr.in/?format=3" || curl -s --max-time 15 "http://wttr.in/?format=3"',
    expect: "other",
    why: "the one non-exploration bash call in the entire archive",
  },
  {
    command:
      'grep -rn "mode" "C:\\Workspace\\Projects\\Lykos\\node_modules\\@earendil-works\\pi-coding-agent\\README.md" | head -20; echo ---; grep -rln "mode" "C:\\Workspace\\Projects\\Lykos\\node_modules\\@earendil-works\\pi-coding-agent\\docs" 2>/dev/null | head',
    expect: "explore",
    why: "backslashes inside a quoted Windows path must not break tokenization",
  },
  { command: 'env | grep -i -E "pi_|model" | head -20', expect: "explore", why: "env is inspection; the pipe splits cleanly" },
  {
    command:
      "env | grep -i '^PI_' ; echo '---' ; node -e \"console.log(process.env.PI_MODEL || 'no PI_MODEL')\" 2>/dev/null",
    expect: "other",
    why: "the conservative rule: a chain that also runs node is not exploration",
  },
  {
    command:
      "cd /c/Workspace/Projects/Lykos && git log --oneline -5 -- docs/17-phase35-terminal-ui-tasks.md && echo --- && head -40 docs/17-phase35-terminal-ui-tasks.md",
    expect: "explore",
    why: "git log is history exploration",
  },
  {
    command: "cd /c/Workspace/Projects/Lykos && ls docs/ | grep -E 'phase|plan' && echo --- && head -30 docs/02-plan.md",
    expect: "explore",
    why: "quoted alternation in the grep pattern must not be read as a separator",
  },
  {
    command: "cd /c/Workspace/Projects/Lykos && git log --oneline -8 && echo --- && git status --short | head",
    expect: "explore",
    why: "git status reads",
  },
  {
    command:
      'cd /c/Workspace/Projects/Lykos && grep -n "Status\\|closed\\|Next\\|feedback round" docs/17-phase35-terminal-ui-tasks.md | head -20',
    expect: "explore",
    why: "the exact command §2's naive splitter mangled into fake command words",
  },
  {
    command: 'cd /c/Workspace/Projects/Lykos && grep -n "2026-09-0" DECISIONS.md | head -15',
    expect: "explore",
    why: "plain search",
  },
  {
    command:
      "cd /c/Workspace/Projects/Lykos && sed -n '497,520p' docs/17-phase35-terminal-ui-tasks.md; echo ===; grep -c \"## \" DECISIONS.md; grep -n \"## 2026-09-0[2-9]\" DECISIONS.md | tail -20",
    expect: "explore",
    why: "sed -n prints a range; it does not write",
  },
  { command: "git status --short && git log --oneline -5", expect: "explore", why: "two read subcommands" },
  { command: "ls docs/ | head -30", expect: "explore", why: "the simplest case" },
  {
    command: "git log --oneline -20 --format='%ad %s' --date=short | head -20; echo ---; git log --oneline | wc -l",
    expect: "explore",
    why: "a quoted format string containing % and spaces",
  },
  {
    command:
      'rg -c "T4[1-9]|T5[0-2]" docs/17-phase35-terminal-ui-tasks.md; rg -n "done|Done|closed|landed|status:" docs/17-phase35-terminal-ui-tasks.md | head -20',
    expect: "explore",
    why: "rg with an unquoted-looking alternation inside quotes",
  },
  { command: "ls", expect: "explore", why: "a bare command word" },
  { command: "git status && ls .lykos 2>/dev/null", expect: "explore", why: "mixed git + ls" },
  {
    command: "git log --oneline -20 && echo --- && git branch -a",
    expect: "explore",
    why: "git branch with only listing flags reads; git branch <name> would not",
  },
  { command: "ls docs | head -30 && echo --- && ls lykos/ui 2>/dev/null | head", expect: "explore", why: "plain listing" },
  {
    command:
      "git log --oneline -3 --format='%h %ad %s' --date=short && echo --- && ls lykos/tui/screen 2>/dev/null | head -20",
    expect: "explore",
    why: "history plus listing",
  },
  { command: 'git log --oneline -5 && echo "---" && git status --short', expect: "explore", why: "history only" },
  {
    command: 'head -40 "docs/17-phase35-terminal-ui-tasks.md" 2>/dev/null || ls docs | head',
    expect: "explore",
    why: "|| splits like && does",
  },
  {
    command:
      "grep -n \"T4[1-9]\\|T5[0-2]\" \"docs/17-phase35-terminal-ui-tasks.md\" | grep -i \"status\\|✓\\|✗\\|open\\|done\\|landed\" | head -20; echo \"---\"; sed -n '/^|.*Task.*Status/,/^$/p' \"docs/17-phase35-terminal-ui-tasks.md\" | head -30",
    expect: "explore",
    why: "the worst case in the archive: quoted pipes, quoted slashes, a sed address range",
  },
];

describe("splitShellSegments (T63)", () => {
  it("splits on unquoted &&, ||, ; and |", () => {
    assert.deepEqual(splitShellSegments("a && b || c ; d | e"), ["a", "b", "c", "d", "e"]);
  });

  it("does not split inside double or single quotes — the bug in §2's throwaway scan", () => {
    // The naive splitter turned this one command into four "commands":
    // `grep -n "Status`, `closed`, `Next" file.md`. It must stay one segment.
    assert.equal(splitShellSegments('grep -n "Status\\|closed\\|Next" file.md').length, 1);
    assert.equal(splitShellSegments("sed -n '/^|.*Task.*Status/,/^$/p' f").length, 1);
  });

  it("does not split the ampersand in a file-descriptor redirect", () => {
    assert.deepEqual(splitShellSegments("rg foo 2>&1"), ["rg foo 2>&1"]);
    assert.deepEqual(splitShellSegments("rg foo 2>&2"), ["rg foo 2>&2"]);
  });

  it("keeps a quoted semicolon out of the split", () => {
    assert.equal(splitShellSegments("grep ';' file").length, 1);
  });

  it("steps into $( ) and backtick substitutions", () => {
    const segs = splitShellSegments("echo $(git rev-parse HEAD)");
    assert.ok(segs.some((s) => s.startsWith("git rev-parse")));
  });

  it("treats a newline as a separator", () => {
    assert.deepEqual(splitShellSegments("ls\ngrep x y"), ["ls", "grep x y"]);
  });
});

describe("tokenizeSegment (T63)", () => {
  it("keeps a quoted argument whole", () => {
    assert.deepEqual(tokenizeSegment('grep -n "two words" file'), ["grep", "-n", "two words", "file"]);
  });

  it("preserves an empty quoted argument as a token", () => {
    assert.deepEqual(tokenizeSegment("grep '' f"), ["grep", "", "f"]);
  });

  it("keeps backslashes from a Windows path", () => {
    assert.deepEqual(tokenizeSegment('cat "C:\\Work\\a.md"'), ["cat", "C:\\Work\\a.md"]);
  });
});

describe("classifyShellSegment (T63)", () => {
  it("classifies the explorer families", () => {
    assert.deepEqual(classifyShellSegment("rg -n foo"), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyShellSegment("head -20 a.md"), { kind: "explore", explore: "read" });
    assert.deepEqual(classifyShellSegment("git log --oneline"), { kind: "explore", explore: "history" });
    assert.deepEqual(classifyShellSegment("wc -l a.md"), { kind: "explore", explore: "inspect" });
  });

  it("treats shell punctuation as neutral, never as exploration", () => {
    assert.deepEqual(classifyShellSegment("cd /repo"), { kind: "neutral" });
    assert.deepEqual(classifyShellSegment("echo ---"), { kind: "neutral" });
    assert.deepEqual(classifyShellSegment(""), { kind: "neutral" });
  });

  it("refuses sed -i and sort -o, which write", () => {
    assert.deepEqual(classifyShellSegment("sed -i 's/a/b/' f"), { kind: "other" });
    assert.deepEqual(classifyShellSegment("sort -o out f"), { kind: "other" });
    assert.deepEqual(classifyShellSegment("sed -n '1,5p' f"), { kind: "explore", explore: "read" });
  });

  it("ignores redirect characters in quoted arguments", () => {
    assert.deepEqual(classifyShellSegment('rg "=>" src'), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyShellSegment('grep "a > b" src'), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyShellSegment('rg "a \\" > b" src'), { kind: "explore", explore: "search" });
  });

  it("refuses a redirect that writes a file but allows harmless targets", () => {
    assert.deepEqual(classifyShellSegment("grep -rn x . > out.txt"), { kind: "other" });
    assert.deepEqual(classifyShellSegment("grep -rn x . >> log"), { kind: "other" });
    assert.deepEqual(classifyShellSegment("ls a 2>/dev/null"), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyShellSegment("ls a 2>&1"), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyShellSegment("ls a 2>&2"), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyShellSegment("ls a 2>/dev/stderr"), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyShellSegment("ls a 2>/dev/stdout"), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyShellSegment('ls a 2>"/dev/null"'), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyShellSegment('ls a 2>"&1"'), { kind: "other" });
    assert.deepEqual(classifyShellSegment('ls a 2>"/dev/null"suffix'), { kind: "other" });
  });

  it("steps past env assignments and wrappers", () => {
    assert.deepEqual(classifyShellSegment("FOO=1 BAR=2 grep x f"), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyShellSegment("sudo ls /root"), { kind: "explore", explore: "search" });
  });

  it("resolves a command given by absolute path", () => {
    assert.deepEqual(classifyShellSegment("/usr/bin/grep -n x f"), { kind: "explore", explore: "search" });
  });

  it("separates read-only git subcommands from writing ones", () => {
    for (const sub of ["log", "status", "show", "diff", "blame", "rev-parse", "ls-files"]) {
      assert.deepEqual(classifyShellSegment(`git ${sub}`), { kind: "explore", explore: "history" }, sub);
    }
    assert.deepEqual(classifyShellSegment("git grep foo"), { kind: "explore", explore: "search" });
    for (const sub of ["commit -m x", "push", "add .", "checkout -b f", "merge main", "rebase -i HEAD~2"]) {
      assert.deepEqual(classifyShellSegment(`git ${sub}`), { kind: "other" }, sub);
    }
  });

  it("reads a git listing only when every argument is a listing flag", () => {
    assert.deepEqual(classifyShellSegment("git branch -a"), { kind: "explore", explore: "history" });
    assert.deepEqual(classifyShellSegment("git tag -l"), { kind: "explore", explore: "history" });
    assert.deepEqual(classifyShellSegment("git branch feature-x"), { kind: "other" });
    assert.deepEqual(classifyShellSegment("git branch -d old"), { kind: "other" });
    assert.deepEqual(classifyShellSegment("git stash list"), { kind: "explore", explore: "history" });
    assert.deepEqual(classifyShellSegment("git stash pop"), { kind: "other" });
  });

  it("honours -C and -c before the subcommand", () => {
    assert.deepEqual(classifyShellSegment("git -C /repo log --oneline"), { kind: "explore", explore: "history" });
    assert.deepEqual(classifyShellSegment("git -C /repo commit -m x"), { kind: "other" });
  });
});

describe("classifyBashCommand (T63) — the conservative rule", () => {
  it("is exploration only when no segment does anything else", () => {
    assert.deepEqual(classifyBashCommand("grep -rn foo . | head"), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyBashCommand("grep -rn foo . && npm test"), { kind: "other" });
    assert.deepEqual(classifyBashCommand("ls && node build.js"), { kind: "other" });
  });

  it("is not exploration when nothing explores", () => {
    assert.deepEqual(classifyBashCommand("npm test"), { kind: "other" });
    assert.deepEqual(classifyBashCommand("echo hi && cd /tmp"), { kind: "other" });
    assert.deepEqual(classifyBashCommand(""), { kind: "other" });
  });

  it("reports the most specific kind present: search > read > history > inspect", () => {
    assert.deepEqual(classifyBashCommand("git log | head"), { kind: "explore", explore: "read" });
    assert.deepEqual(classifyBashCommand("git log && grep -n x f"), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyBashCommand("git log && wc -l f"), { kind: "explore", explore: "history" });
  });

  describe("every bash command in the archive, 2026-09-03", () => {
    for (const { command, expect, why } of ARCHIVE_COMMANDS) {
      it(`${expect}: ${why}`, () => {
        assert.equal(classifyBashCommand(command).kind, expect, command);
      });
    }
  });

  it("reproduces the archive's headline ratio", () => {
    const explored = ARCHIVE_COMMANDS.filter((c) => classifyBashCommand(c.command).kind === "explore").length;
    // 25 distinct commands (the archive's 26 `bash` calls that recorded a
    // command include one exact duplicate), of which 23 explore. The two that
    // do not are the `curl` and the chain that also runs `node`.
    //
    // Note this is *lower* than §2's headline: that scan used the permissive
    // rule (any segment explores) and did not exclude the `node` chain. The
    // strict rule costs one call here, and that is the intended direction —
    // T67's gate must not be handed an inflated numerator.
    assert.equal(ARCHIVE_COMMANDS.length, 25);
    assert.equal(explored, 23);
  });
});

describe("classifyToolCall (T63)", () => {
  it("counts the read tool, and the three names T20 removed", () => {
    assert.deepEqual(classifyToolCall({ name: "read" }), { kind: "explore", explore: "read" });
    assert.deepEqual(classifyToolCall({ name: "grep" }), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyToolCall({ name: "find" }), { kind: "explore", explore: "search" });
    assert.deepEqual(classifyToolCall({ name: "ls" }), { kind: "explore", explore: "search" });
  });

  it("unwraps tool_call to classify by the actual tool (P10.2)", () => {
    assert.deepEqual(classifyToolCall({ name: "tool_call", args: { name: "read", arguments: { path: "a.ts" } } }), {
      kind: "explore",
      explore: "read",
    });
    assert.deepEqual(classifyToolCall({ name: "tool_call", args: { name: "edit", arguments: { path: "a.ts" } } }), {
      kind: "edit",
    });
    assert.deepEqual(classifyToolCall({ name: "tool_call", args: { name: "bash", arguments: { command: "ls -la" } } }), {
      kind: "explore",
      explore: "search",
    });
  });
  it("classifies edit and write as edits, never as exploration", () => {
    assert.deepEqual(classifyToolCall({ name: "edit" }), { kind: "edit" });
    assert.deepEqual(classifyToolCall({ name: "write" }), { kind: "edit" });
  });

  it("reads the bash command out of args", () => {
    assert.deepEqual(classifyToolCall({ name: "bash", args: { command: "ls -la" } }), {
      kind: "explore",
      explore: "search",
    });
  });

  it("counts quoted search patterns and harmless redirects as exploration", () => {
    const s = summarizeExploration([
      { name: "bash", args: { command: 'rg "=>" src' }, result: "arrow" },
      { name: "bash", args: { command: "rg foo . 2>&1" }, result: "stderr" },
      { name: "bash", args: { command: "rg foo . > out.txt" }, result: "write" },
    ]);
    assert.equal(s.exploreToolCalls, 2);
    assert.equal(s.byKind.search.calls, 2);
  });

  it("refuses to guess when a bash call recorded no command", () => {
    assert.deepEqual(classifyToolCall({ name: "bash" }), { kind: "other" });
    assert.deepEqual(classifyToolCall({ name: "bash", args: { truncated: true } }), { kind: "other" });
  });

  it("ignores subagent-host tools", () => {
    for (const name of ["agent", "get_subagent_result", "steer_subagent"]) {
      assert.deepEqual(classifyToolCall({ name }), { kind: "other" }, name);
    }
  });
});

describe("summarizeExploration (T63)", () => {
  it("increments the metric version when the classifier definition changes", () => {
    assert.equal(EXPLORE_METRIC_VERSION, 3);
  });

  it("counts calls and bytes, and separates the denominator from the numerator", () => {
    const s = summarizeExploration([
      { name: "bash", args: { command: "grep -rn x ." }, result: "a".repeat(100) },
      { name: "read", result: "b".repeat(50) },
      { name: "bash", args: { command: "npm test" }, result: "c".repeat(30) },
      { name: "edit", result: "ok" },
    ]);
    assert.equal(s.exploreToolCalls, 2);
    assert.equal(s.exploreResultBytes, 150);
    assert.equal(s.toolResultBytes, 182);
    assert.equal(s.byKind.search.calls, 1);
    assert.equal(s.byKind.search.bytes, 100);
    assert.equal(s.byKind.read.calls, 1);
    assert.equal(s.byKind.read.bytes, 50);
    assert.equal(s.metricVersion, EXPLORE_METRIC_VERSION);
  });

  it("takes the recorded byte count from a spilled artifact result", () => {
    const s = summarizeExploration([
      { name: "bash", args: { command: "ls -R" }, result: { truncated: true, bytes: 18587, artifact: "artifacts/0001.json" } },
    ]);
    assert.equal(s.exploreResultBytes, 18587);
    assert.equal(s.toolResultBytes, 18587);
  });

  it("is empty on an undefined or empty trace", () => {
    for (const t of [undefined, []]) {
      const s = summarizeExploration(t);
      assert.equal(s.exploreToolCalls, 0);
      assert.equal(s.toolResultBytes, 0);
    }
  });

  it("serializes a breakdown that round-trips", () => {
    const s = summarizeExploration([{ name: "read", result: "x" }]);
    assert.deepEqual(JSON.parse(serializeBreakdown(s)).read, { calls: 1, bytes: 1 });
  });
});

describe("exploreShare (T63)", () => {
  it("is the byte ratio", () => {
    assert.equal(exploreShare({ exploreResultBytes: 75, toolResultBytes: 100 }), 0.75);
  });

  it("is NULL, not zero, when the session ran no tool at all", () => {
    assert.equal(exploreShare({ exploreResultBytes: 0, toolResultBytes: 0 }), null);
  });
});
