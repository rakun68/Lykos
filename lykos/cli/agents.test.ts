import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadAgentListing, runAgentsList, runAgentsShow } from "./agents.js";

const SCOUT_MD = `---
name: scout
model: deepseek-v4-flash
tools: read, grep, glob
extensions: false
allowed_subagents: none
memory: project
inherit_context: false
---

Read-only exploration.
`;

function tempAgentsDir(): string {
  const root = mkdtempSync(join(tmpdir(), "lykos-agentscli-"));
  const dir = join(root, ".lykos", "agents");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function captureStdout(fn: () => number): { code: number; out: string } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = fn();
    return { code, out: chunks.join("") };
  } finally {
    process.stdout.write = original;
  }
}

function captureStderr(fn: () => number): { code: number; err: string } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = fn();
    return { code, err: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

describe("loadAgentListing", () => {
  it("reads name, model, and tools from every .md file", () => {
    const dir = tempAgentsDir();
    writeFileSync(join(dir, "scout.md"), SCOUT_MD, "utf8");
    writeFileSync(join(dir, "watcher.md"), SCOUT_MD.replace("scout", "watcher").replace("grep, glob", "grep, glob, bash"), "utf8");

    const listing = loadAgentListing(dir);
    assert.deepEqual(
      listing.map((l) => l.name),
      ["scout", "watcher"],
    );
    assert.equal(listing[0]!.model, "deepseek-v4-flash");
    assert.equal(listing[0]!.tools, "read, grep, glob");
  });

  it("returns an empty list for a missing directory", () => {
    assert.deepEqual(loadAgentListing(join(tmpdir(), "lykos-agents-does-not-exist")), []);
  });
});

describe("runAgentsList", () => {
  it("prints name/model/tools for every agent", () => {
    const dir = tempAgentsDir();
    writeFileSync(join(dir, "scout.md"), SCOUT_MD, "utf8");

    const { code, out } = captureStdout(() => runAgentsList(dir));
    assert.equal(code, 0);
    assert.match(out, /scout/);
    assert.match(out, /deepseek-v4-flash/);
    assert.match(out, /read, grep, glob/);
  });

  it("reports no agents found rather than an empty success with no explanation", () => {
    const dir = tempAgentsDir();
    const { code, out } = captureStdout(() => runAgentsList(dir));
    assert.equal(code, 0);
    assert.match(out, /no agent definitions/);
  });
});

describe("runAgentsShow", () => {
  it("prints the full raw file for a real agent", () => {
    const dir = tempAgentsDir();
    writeFileSync(join(dir, "scout.md"), SCOUT_MD, "utf8");

    const { code, out } = captureStdout(() => runAgentsShow(dir, "scout"));
    assert.equal(code, 0);
    assert.equal(out, SCOUT_MD);
  });

  it("fails with a clear message and nonzero exit for an unknown name", () => {
    const dir = tempAgentsDir();
    writeFileSync(join(dir, "scout.md"), SCOUT_MD, "utf8");

    const { code, err } = captureStderr(() => runAgentsShow(dir, "nonexistent"));
    assert.equal(code, 1);
    assert.match(err, /no agent named "nonexistent"/);
  });
});
