// T248: the context pack. Each Boxie lesson it applies is tested on a real git repository, not a stand-in:
// F3 (the pack quotes the base commit, not the working tree) and W8 (every path in the pack is absolute). The pack
// is recorded in the ledger and `lykos status` shows it; a session started by the child is given it, rooted at its
// own worktree.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { defaultLedgerPath, openLedgerSync, withLedgerSync } from "../ledger/use.js";
import type { RunStandaloneTaskInput } from "../session/session.js";
import { runSessionChild } from "../cli/session-child.js";
import { encodeFrame, PROTOCOL_VERSION, type SessionRequest } from "./session-protocol.js";
import { admit } from "./ownership.js";
import { ledgerViews } from "./mcp-server.js";
import { buildContextPack, recordContextPack } from "./context-pack.js";
import type { Ledger } from "../ledger/use.js";

/** The pack text a session was given, as the ledger holds it. */
function contextPackText(ledger: Ledger, sessionId: string): string | undefined {
  return (ledger.db.prepare("SELECT text FROM context_packs WHERE session_id = ?").get(sessionId) as { text: string } | undefined)?.text;
}

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const saved: Record<string, string | undefined> = {};
let home: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), "lykos-t248-home-"));
  for (const k of ["HOME", "USERPROFILE", "LYKOS_TRUST_WORKSPACE", "NODE_TEST_CONTEXT"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LYKOS_TRUST_WORKSPACE = "1";
  delete process.env.NODE_TEST_CONTEXT;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
}

function put(dir: string, rel: string, text: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

const GLOSSARY_AT_BASE = "# G\n\n**Widget**:\nThe BASE-WIDGET meaning, as the base commit has it.\n_Avoid_: gizmo\n\n**Unused**:\nA term nobody mentions.\n";
const AGENTS = "# A\n\n## The rules\n\n**1. Read the base.** Always.\n\n## Traps\n\n**A trap named BASE-TRAP.**\n\n## Git\n\nCommit.\n";

/** A project with a base commit, a later commit and a working tree that differs from both. */
function project(): { repo: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), "lykos t248 "));
  git(repo, "init", "-q", "-b", "main");
  put(repo, "AGENTS.md", AGENTS);
  put(repo, "GLOSSARY.md", GLOSSARY_AT_BASE);
  put(repo, "src/widget.ts", "export const widget = 1; // a Widget\n");
  put(repo, "src/widget.test.ts", "// tests\n");
  put(repo, "src/other.test.ts", "// not about the widget\n");
  put(repo, "docs/reference/widgets.md", "The widget lives in src/widget.ts.\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  put(repo, "GLOSSARY.md", "# G\n\n**Widget**:\nThe LATER-WIDGET meaning, committed after the base.\n");
  git(repo, "commit", "-qam", "later");
  put(repo, "GLOSSARY.md", "# G\n\n**Widget**:\nThe WORKTREE-WIDGET meaning, uncommitted.\n");
  return { repo, base };
}

describe("T248 F3: the pack reads the base commit, not the working tree", () => {
  it("quotes the base commit's glossary when the working tree and a later commit differ", () => {
    const { repo, base } = project();
    const pack = buildContextPack({ root: repo, repo, base, files: ["src/widget.ts"], task: "Change the widget" });
    assert.match(pack.text, /BASE-WIDGET/);
    assert.doesNotMatch(pack.text, /LATER-WIDGET|WORKTREE-WIDGET/);
    assert.ok(!pack.text.includes("A term nobody mentions"), "only the terms the task and its files use");
    assert.equal(pack.base, base, "a ref resolves to the commit it names");
  });

  it("quotes the base's rules and traps, and lists a file the base lacks as new, never from the tree", () => {
    const { repo, base } = project();
    put(repo, "src/fresh.ts", "export const fresh = 'WORKTREE-ONLY';\n");
    const pack = buildContextPack({ root: repo, repo, base: "main~1", files: ["src/fresh.ts"] });
    assert.equal(pack.base, base);
    assert.match(pack.text, /Read the base/);
    assert.match(pack.text, /BASE-TRAP/);
    assert.ok(!pack.text.includes("WORKTREE-ONLY"));
    assert.ok(pack.entries.some((e) => e.kind === "file" && e.text.startsWith("new")));
  });

  it("carries the related tests, the docs that name the files, their history and the verification command", () => {
    const { repo, base } = project();
    const pack = buildContextPack({ root: repo, repo, base, files: ["src/widget.ts"], test: "npm test -- widget" });
    const paths = (kind: string): string[] => pack.entries.filter((e) => e.kind === kind).map((e) => e.path ?? "");
    assert.deepEqual(paths("test"), [join(repo, "src", "widget.test.ts")]);
    assert.deepEqual(paths("doc"), [join(repo, "docs", "reference", "widgets.md")]);
    assert.match(pack.entries.find((e) => e.kind === "history")?.text ?? "", /base$/);
    assert.match(pack.text, /## Verification command\nnpm test -- widget$/);
  });
});

describe("T248 W8: every path in the pack is absolute", () => {
  it("roots every path at the session's tree and writes no relative path", () => {
    const { repo, base } = project();
    const worktree = join(mkdtempSync(join(tmpdir(), "lykos t248 wt ")), "tree");
    const pack = buildContextPack({ root: worktree, repo, base, files: ["src/widget.ts", "src/fresh.ts"], task: "Change the widget" });
    const withPaths = pack.entries.filter((e) => e.path !== undefined);
    assert.ok(withPaths.length >= 6, "rules, traps, files, glossary, doc, history and test entries have paths");
    for (const e of withPaths) {
      assert.ok(isAbsolute(e.path!), `${e.kind}: ${e.path}`);
      assert.ok(e.path!.startsWith(worktree), `${e.kind} is under the session's tree: ${e.path}`);
    }
    // The text the session reads: take the absolute paths out and no project-relative path remains.
    let text = pack.text;
    for (const e of withPaths) text = text.split(e.path!).join("<abs>");
    for (const rel of ["src/widget.ts", "src/widget.test.ts", "src/fresh.ts", "docs/reference/widgets.md", "AGENTS.md", "GLOSSARY.md"]) {
      assert.ok(!text.includes(rel), `${rel} appears only inside an absolute path`);
    }
  });

  it("counts a file's lines as the file has them: a final newline ends a line, it does not start one", () => {
    const { repo, base } = project();
    // src/widget.ts at the base is one line, ended by a newline.
    const pack = buildContextPack({ root: repo, repo, base, files: ["src/widget.ts"] });
    assert.equal(pack.entries.find((e) => e.kind === "file" && e.path === join(repo, "src", "widget.ts"))?.text, "1 line at the base");
  });

  it("a qualified glossary entry (`**Term**:` with its qualifier in the text) is quoted for a task that names it", () => {
    const { repo } = project();
    put(repo, "GLOSSARY.md", "# G\n\n**Block**:\nOf a finding: the BLOCK-MEANING.\n");
    git(repo, "commit", "-qam", "block");
    const pack = buildContextPack({ root: repo, repo, base: "HEAD", files: ["src/widget.ts"], task: "When does a finding Block?" });
    assert.match(pack.text, /BLOCK-MEANING/);
  });

  it("the project's own GLOSSARY.md starts every entry with `**Term**:`, the one shape the pack reads", () => {
    const glossary = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "GLOSSARY.md"), "utf8");
    const heads = glossary.split(/\r?\n/).filter((l) => l.startsWith("**") && !l.startsWith("**Avoid"));
    const misshapen = heads.filter((l) => !/^\*\*(.+?)\*\*:\s*(.*)$/.test(l));
    assert.deepEqual(misshapen, []);
  });

  it("takes a task file given as an absolute path in the project", () => {
    const { repo, base } = project();
    const pack = buildContextPack({ root: repo, repo, base, files: [join(repo, "src", "widget.ts")] });
    assert.ok(pack.entries.some((e) => e.kind === "file" && e.path === join(repo, "src", "widget.ts") && /lines? at the base/.test(e.text)));
  });
});

describe("T248: recorded in the ledger and shown by status", () => {
  it("records the pack with its session and `lykos status` shows its base, root and entries", () => {
    const { repo, base } = project();
    const ledgerPath = defaultLedgerPath(repo);
    const pack = buildContextPack({ root: repo, repo, base, files: ["src/widget.ts"], task: "widget", test: "npm test" });
    withLedgerSync(ledgerPath, (ledger) => {
      assert.equal(admit(ledger, { sessionId: "s-pack", owner: "run", specialist: "implement", projectCap: 4 }).ok, true);
      assert.equal(admit(ledger, { sessionId: "s-bare", owner: "run", specialist: "implement", projectCap: 4 }).ok, true);
      recordContextPack(ledger, "s-pack", pack);
      assert.equal(contextPackText(ledger, "s-pack"), pack.text, "the text the session read is what is stored");
    });
    const views = ledgerViews(repo);
    const shown = views.find((v) => v.session_id === "s-pack")?.context_pack;
    assert.ok(shown);
    assert.equal(shown.base, base);
    assert.equal(shown.root, repo);
    assert.deepEqual(shown.entries, pack.entries.map((e) => ({ kind: e.kind, ...(e.path !== undefined ? { path: e.path } : {}) })));
    assert.equal(views.find((v) => v.session_id === "s-bare")?.context_pack, undefined, "a session with no task has no pack");
    openLedgerSync(ledgerPath).close();
  });
});

describe("T248: a new session is given the pack, recorded before the model runs", () => {
  async function drive(workspace: string, extra: Partial<SessionRequest>): Promise<{ seen: RunStandaloneTaskInput[]; ledgerPath: string }> {
    const seen: RunStandaloneTaskInput[] = [];
    const input = new PassThrough();
    const ledgerPath = defaultLedgerPath(workspace);
    const request: SessionRequest = { version: PROTOCOL_VERSION, tool: "lykos_implement", workspace, prompt: "Change the widget", label: "lykos_implement", ...extra };
    input.write(encodeFrame(request));
    await runSessionChild({
      input,
      write: () => undefined,
      env: { LYKOS_TRUST_SOURCE: "flag", LYKOS_TRUST_WORKSPACE: "1" },
      trustPath: join(home, "trust.json"),
      worktreesRoot: mkdtempSync(join(tmpdir(), "lykos t248 child ")),
      runTask: async (task) => {
        seen.push(task);
        return { status: "ok", sessionId: task.sessionId ?? "unset", text: "ok", snapshot: {} as never };
      },
      onParentGone: () => undefined,
    });
    input.end();
    return { seen, ledgerPath };
  }

  it("appends the pack to the brief, rooted at the session's worktree, and records it under the session", async () => {
    const { repo, base } = project();
    git(repo, "checkout", "-q", "--", "GLOSSARY.md");
    const { seen, ledgerPath } = await drive(repo, { base, context: { files: ["src/widget.ts"], test: "npm test" } });
    const task = seen[0]!;
    assert.ok(task.workTree !== undefined && task.sessionId !== undefined);
    assert.ok(task.prompt.startsWith("Change the widget"));
    assert.ok(task.prompt.includes(join(task.workTree.path, "src", "widget.ts")), "the file's path is under the session's worktree");
    assert.match(task.prompt, /BASE-WIDGET/);
    const text = withLedgerSync(ledgerPath, (ledger) => contextPackText(ledger, task.sessionId!));
    assert.ok(text !== undefined && task.prompt.endsWith(text), "what was recorded is what the model got");
  });

  it("gives no pack to a task with no files and no command", async () => {
    const { repo } = project();
    const bare = await drive(repo, {});
    assert.equal(bare.seen[0]!.prompt, "Change the widget");
  });
});

describe("T248 review: a project that does not use this repository's rule headings still gets its rules", () => {
  function bare(files: Record<string, string>): { repo: string; base: string } {
    const repo = mkdtempSync(join(tmpdir(), "lykos t248 rules "));
    git(repo, "init", "-q", "-b", "main");
    put(repo, "src/a.ts", "export const a = 1;\n");
    for (const [rel, text] of Object.entries(files)) put(repo, rel, text);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    return { repo, base: git(repo, "rev-parse", "HEAD") };
  }

  it("takes an AGENTS.md whose headings are its own whole, and a CLAUDE.md beside or instead of it", () => {
    const { repo, base } = bare({
      "AGENTS.md": "# Team\n\n## Style\n\nUse tabs. STYLE-RULE.\n",
      "CLAUDE.md": "# Claude\n\n## Workflow\n\nRun lint first. CLAUDE-RULE.\n",
    });
    const pack = buildContextPack({ root: repo, repo, base, files: ["src/a.ts"] });
    const rules = pack.entries.filter((e) => e.kind === "rules");
    assert.deepEqual(rules.map((e) => e.path), [join(repo, "AGENTS.md"), join(repo, "CLAUDE.md")]);
    assert.match(pack.text, /STYLE-RULE/);
    assert.match(pack.text, /CLAUDE-RULE/);
  });

  it("quotes only the known sections of a file that has them, as before", () => {
    const { repo, base } = bare({ "AGENTS.md": `${AGENTS}\n## Extra\n\nNOT-QUOTED-EXTRA.\n` });
    const pack = buildContextPack({ root: repo, repo, base, files: ["src/a.ts"] });
    assert.match(pack.text, /Read the base/);
    assert.doesNotMatch(pack.text, /NOT-QUOTED-EXTRA/);
  });

  it("says so when the base has no rule file", () => {
    const { repo, base } = bare({});
    const pack = buildContextPack({ root: repo, repo, base, files: ["src/a.ts"] });
    assert.match(pack.text, /## Project rules\nNo AGENTS\.md or CLAUDE\.md at the base commit/);
  });
});

describe("T248 review (W8): a file outside the project is placed against the session's root, not the process's directory", () => {
  it("resolves a relative outside path under the session's tree", () => {
    const { repo, base } = project();
    const worktree = join(mkdtempSync(join(tmpdir(), "lykos t248 wt2 ")), "tree");
    const pack = buildContextPack({ root: worktree, repo, base, files: ["../notes/outside.md"] });
    const entry = pack.entries.find((e) => e.kind === "file" && e.text === "outside the project");
    assert.equal(entry?.path, join(worktree, "..", "notes", "outside.md"));
    assert.notEqual(entry?.path, join(process.cwd(), "..", "notes", "outside.md"));
  });
});
