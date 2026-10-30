import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { ensureWorkspaceTrust, WorkspaceTrustError } from "./trust.js";

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "lykos-trust-"));
}

test("T118 refuses an untrusted headless workspace without writing trust", async () => {
  const workspace = tempWorkspace();
  const trustPath = join(workspace, "trust.json");
  await assert.rejects(
    ensureWorkspaceTrust({ workspace, trustPath, interactive: false }),
    (error: unknown) => error instanceof WorkspaceTrustError,
  );
  assert.equal(existsSync(trustPath), false);
});

test("T118's one-run flag grants access without persisting a decision", async () => {
  const workspace = tempWorkspace();
  const trustPath = join(workspace, "trust.json");
  const decision = await ensureWorkspaceTrust({ workspace, trustPath, trustWorkspace: true, interactive: false });
  assert.equal(decision.source, "flag");
  assert.equal(existsSync(trustPath), false);
});

test("T117 persists only an explicit interactive yes", async () => {
  const workspace = tempWorkspace();
  const trustPath = join(workspace, "trust.json");
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const decision = await ensureWorkspaceTrust({
    workspace,
    trustPath,
    interactive: true,
    input: Readable.from(["yes\n"]),
    output,
  });
  assert.equal(decision.source, "prompt");
  assert.match(readFileSync(trustPath, "utf8"), new RegExp(decision.projectId));
});

test("a project in the store reports stored even when the one-run flag is also set", async () => {
  const workspace = tempWorkspace();
  const trustPath = join(workspace, "trust.json");
  // A git repository, so the project keeps one identity between calls.
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: workspace });
  const projectId = (await ensureWorkspaceTrust({ workspace, trustPath, trustWorkspace: true, interactive: false })).projectId;
  writeFileSync(trustPath, JSON.stringify({ version: 1, projects: { [projectId]: { trustedUtc: "2026-01-01T00:00:00Z" } } }));
  const decision = await ensureWorkspaceTrust({ workspace, trustPath, trustWorkspace: true, interactive: false });
  assert.equal(decision.source, "stored");
});
