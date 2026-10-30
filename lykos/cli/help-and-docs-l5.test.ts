// L5 (issue #93, items 5, 6a, 7, 8): help that cannot drift from dispatch, a
// seal_events doc that lists every kind, a specialist tool that wins an alias
// clash without a deprecation note, and the warm pool's cost stated.
// Sealed acceptance test.
//
// New seams are reached through dynamic imports of a computed specifier, so
// this file type-checks before they exist.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../delegate/mcp-server.js";
import type { SessionOutcome, SessionRequest, SessionRunner } from "../delegate/session-protocol.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "lykos", "cli.ts");
const TSX = import.meta.resolve("tsx");

/** Imports a module that may not exist yet without tsc resolving it. */
async function load(rel: string): Promise<Record<string, unknown>> {
  const spec: string = new URL(rel, import.meta.url).href;
  return (await import(spec)) as Record<string, unknown>;
}

function lykos(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const cwd = mkdtempSync(join(tmpdir(), "lykos-l5-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "lykos-l5-home-"));
  const res = spawnSync(process.execPath, ["--import", TSX, CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Command names a help text lists: a line indented exactly two spaces starts with one. */
function helpNames(help: string): Set<string> {
  const names = new Set<string>();
  for (const line of help.split(/\r?\n/)) {
    const m = /^ {2}(\S+)/.exec(line);
    if (m) names.add(m[1]!);
  }
  return names;
}

type Command = { name: string; aliases?: readonly string[]; help: readonly string[]; run: unknown };

describe("L5 item 5: help comes from the table that dispatches", () => {
  it("`lykos --help` names `session`, the listing that exists, and not `sessions`", () => {
    const res = lykos(["--help"]);
    assert.equal(res.status, 0, res.stderr);
    const names = helpNames(res.stdout);
    assert.ok(names.has("session"), `help lists session: ${[...names].join(", ")}`);
    assert.ok(!names.has("sessions"), "help does not list sessions, which is an unknown command");
  });

  it("`lykos sessions` is still unknown, and `lykos session --json` lists", () => {
    const unknown = lykos(["sessions"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown command "sessions"/);
    const listed = lykos(["session", "--json"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.doesNotMatch(listed.stderr, /unknown command/);
  });

  it("lykos/cli/commands.ts exports COMMANDS and usageText, and `lykos --help` prints usageText()", async () => {
    const mod = await load("./commands.js");
    assert.ok(Array.isArray(mod.COMMANDS), "COMMANDS is an array");
    assert.equal(typeof mod.usageText, "function", "usageText is a function");
    const res = lykos(["--help"]);
    assert.equal(res.stdout, (mod.usageText as () => string)(), "help is produced from the table");
  });

  it("every command help lists is a table entry with a handler, and every entry with help is listed", async () => {
    const mod = await load("./commands.js");
    const commands = mod.COMMANDS as Command[];
    const known = new Set(commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    for (const c of commands) assert.equal(typeof c.run, "function", `${c.name} has a run handler`);
    const listed = helpNames(lykos(["--help"]).stdout);
    for (const name of listed) assert.ok(known.has(name), `help lists ${name}, and the table dispatches it`);
    for (const c of commands) if (c.help.length > 0) assert.ok(listed.has(c.name), `${c.name} has help and is listed`);
    assert.ok(known.has("session") && !known.has("sessions"), "the table has session, not sessions");
  });

  it("cli.ts has no second dispatch: no `case \"<name>\":` label for any table command", async () => {
    const mod = await load("./commands.js");
    const commands = mod.COMMANDS as Command[];
    const source = readFileSync(CLI, "utf8");
    for (const c of commands) {
      for (const name of [c.name, ...(c.aliases ?? [])]) {
        assert.ok(!source.includes(`case "${name}":`), `cli.ts still switches on "${name}" outside the table`);
      }
    }
  });
});

/** Every kind the code writes to seal_events at d854489. */
const SEAL_KINDS = [
  "created",
  "verified",
  "tampered",
  "vetoed",
  "bash-warned",
  "rejected",
  "failed",
  "not collected",
  "disputed",
  "weakened",
  "tamper_attempted",
  "dispute filed",
  "dispute escalated",
  "dispute upheld",
  "dispute rejected",
];

describe("L5 item 6a: docs/reference/telemetry.md lists every seal_events kind", () => {
  it("ledger.ts exports SEAL_EVENT_KINDS holding every kind the code writes, and types SealEventInput.kind by it", async () => {
    const mod = await load("../ledger/ledger.js");
    const kinds = mod.SEAL_EVENT_KINDS as readonly string[] | undefined;
    assert.ok(Array.isArray(kinds), "SEAL_EVENT_KINDS exported");
    for (const k of SEAL_KINDS) assert.ok(kinds.includes(k), `SEAL_EVENT_KINDS has "${k}"`);
    const source = readFileSync(join(ROOT, "lykos", "ledger", "ledger.ts"), "utf8");
    const input = /export interface SealEventInput \{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
    assert.match(input, /kind:\s*SealEventKind;/, "SealEventInput.kind is SealEventKind, so tsc refuses an unlisted kind");
  });

  it("the doc's seal_events entry names each kind in SEAL_EVENT_KINDS", async () => {
    const doc = readFileSync(join(ROOT, "docs", "reference", "telemetry.md"), "utf8");
    const entry = doc.split(/\r?\n/).find((l) => l.startsWith("- `seal_events`")) ?? "";
    assert.ok(entry.length > 0, "the seal_events entry exists");
    const mod = await load("../ledger/ledger.js");
    const kinds = (mod.SEAL_EVENT_KINDS as readonly string[] | undefined) ?? SEAL_KINDS;
    const missing = kinds.filter((k) => !entry.includes(`\`${k}\``));
    assert.deepEqual(missing, [], `telemetry.md seal_events kinds missing: ${missing.join(", ")}`);
  });
});

// --- MCP harness, as lykos/delegate/specialist-tools-t222.test.ts ---

afterEach(() => {
  delete process.env.LYKOS_TRUST_WORKSPACE;
});

function repo(files: Record<string, string> = {}): string {
  const workspace = mkdtempSync(join(tmpdir(), "lykos-l5-ws-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(workspace, rel)), { recursive: true });
    writeFileSync(join(workspace, rel), content);
  }
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: workspace });
  return workspace;
}

async function withServer<T>(workspace: string, run: SessionRunner, body: (client: Client) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "lykos-l5-home-"));
  mkdirSync(join(home, ".lykos", "specialists"), { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LYKOS_TRUST_WORKSPACE = "1";
  try {
    const trustPath = join(mkdtempSync(join(tmpdir(), "lykos-l5-store-")), "trust.json");
    const server = createMcpServer({ workspace, version: "0.0.1-test", trustPath, run });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "lykos-l5-client", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      return await body(client);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const ok = async (): Promise<SessionOutcome> => ({ outcome: "ok", answer: "done", sessionId: "sess-1" });

async function descriptions(workspace: string): Promise<Map<string, string>> {
  return withServer(workspace, ok, async (client) => {
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, t.description ?? ""]));
  });
}

describe("L5 item 7: on an alias clash the specialist's tool wins, with no deprecation note", () => {
  it("lykos_review is the review specialist's tool and is not described as deprecated", async () => {
    const tools = await descriptions(repo());
    const review = tools.get("lykos_review") ?? "";
    assert.ok(review.startsWith("Review a change without touching it"), `the specialist's description: ${review}`);
    assert.doesNotMatch(review, /deprecat/i, `no deprecation note: ${review}`);
  });

  it("a project specialist named implement wins lykos_implement, with no deprecation note", async () => {
    const tools = await descriptions(repo({ ".lykos/specialists/implement.yaml": "description: PROJECT implementer.\nrole: subagent\n" }));
    const implement = tools.get("lykos_implement") ?? "";
    assert.ok(implement.startsWith("PROJECT implementer."), implement);
    assert.doesNotMatch(implement, /deprecat/i, `no deprecation note: ${implement}`);
  });

  it("an alias no specialist claims stays deprecated", async () => {
    const tools = await descriptions(repo());
    for (const name of ["lykos_implement", "lykos_refactor", "lykos_debug"]) {
      assert.match(tools.get(name) ?? "", /deprecated/i, `${name} still deprecated`);
    }
  });

  it("lykos_review still runs the review specialist", async () => {
    const seen: SessionRequest[] = [];
    await withServer(repo(), async ({ request }) => (seen.push(request), ok()), (client) =>
      client.callTool({ name: "lykos_review", arguments: { brief: "the diff" } }),
    );
    assert.equal(seen[0]?.specialist, "review");
  });

  it("docs/reference/mcp.md's alias-clash rule says exactly that, short, and nothing calls lykos_review deprecated", () => {
    const doc = readFileSync(join(ROOT, "docs", "reference", "mcp.md"), "utf8");
    const para = doc.split(/\r?\n/).find((l) => l.startsWith("**Alias clash rule:**")) ?? "";
    assert.ok(para.length > 0, "the alias clash rule paragraph exists");
    assert.ok(para.length <= 400, `short: ${para.length} characters`);
    assert.match(para, /specialist's tool wins/i, para);
    assert.match(para, /no deprecation note/i, para);
    const reviewBullet = doc.split(/\r?\n/).find((l) => l.startsWith("- `lykos_review`")) ?? "";
    assert.doesNotMatch(reviewBullet, /deprecat/i, `lykos_review bullet: ${reviewBullet}`);
  });
});

describe("L5 item 8: the warm pool's cost is stated", () => {
  it("cli-and-config.md's mcp.warm_pool line says K idle node processes per workspace and trust source", () => {
    const doc = readFileSync(join(ROOT, "docs", "reference", "cli-and-config.md"), "utf8");
    const line = doc.split(/\r?\n/).find((l) => /^\s*warm_pool:/.test(l)) ?? "";
    assert.ok(line.length > 0, "the warm_pool line exists");
    assert.match(line, /K idle node processes per workspace and trust source/, line);
  });
});
