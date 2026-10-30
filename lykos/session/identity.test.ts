import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { auditRegistry, detectFirstCommit, detectGitRemote, resolveProject } from "./identity.js";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(dir: string, opts?: { remote?: string }): void {
  git(["init", "-q"], dir);
  git(["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "init"], dir);
  if (opts?.remote) git(["remote", "add", "origin", opts.remote], dir);
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("resolveProject", () => {
  it("creates a new project on first resolve, keyed by its git remote", () => {
    const workspace = tempDir("lykos-identity-new-");
    initRepo(workspace, { remote: "https://example.com/rakun68/lykos.git" });
    const registryPath = join(tempDir("lykos-identity-registry-"), "projects.json");

    const result = resolveProject(workspace, { registryPath });
    assert.equal(result.created, true);
    assert.equal(result.repaired, false);
    assert.equal(result.record.root_path, workspace);
    assert.equal(result.record.git_remote, "https://example.com/rakun68/lykos.git");
    assert.equal(result.record.first_commit, detectFirstCommit(workspace));

    const written = JSON.parse(readFileSync(registryPath, "utf8")) as { projects: unknown[] };
    assert.equal(written.projects.length, 1);
  });

  it("matches an existing project by git remote on a second resolve, without creating a duplicate", () => {
    const workspace = tempDir("lykos-identity-match-");
    initRepo(workspace, { remote: "https://example.com/rakun68/lykos.git" });
    const registryPath = join(tempDir("lykos-identity-registry-"), "projects.json");

    const first = resolveProject(workspace, { registryPath });
    const second = resolveProject(workspace, { registryPath });
    assert.equal(second.id, first.id);
    assert.equal(second.created, false);

    const written = JSON.parse(readFileSync(registryPath, "utf8")) as { projects: unknown[] };
    assert.equal(written.projects.length, 1);
  });

  it("falls back to first-commit matching when there is no git remote", () => {
    const workspace = tempDir("lykos-identity-no-remote-");
    initRepo(workspace); // no remote
    assert.equal(detectGitRemote(workspace), undefined);
    const registryPath = join(tempDir("lykos-identity-registry-"), "projects.json");

    const first = resolveProject(workspace, { registryPath });
    assert.equal(first.record.git_remote, null);
    assert.ok(first.record.first_commit);

    const second = resolveProject(workspace, { registryPath });
    assert.equal(second.id, first.id);
    assert.equal(second.created, false);
  });

  it("repairs a stale root_path when the same project is found at a new location", () => {
    const before = tempDir("lykos-identity-old-");
    initRepo(before, { remote: "https://example.com/rakun68/lykos.git" });
    const registryPath = join(tempDir("lykos-identity-registry-"), "projects.json");
    const first = resolveProject(before, { registryPath });

    const parent = tempDir("lykos-identity-moved-parent-");
    const after = join(parent, "moved-repo");
    renameSync(before, after);

    const second = resolveProject(after, { registryPath });
    assert.equal(second.id, first.id);
    assert.equal(second.repaired, true);
    assert.equal(second.record.root_path, after);

    const written = JSON.parse(readFileSync(registryPath, "utf8")) as {
      projects: Array<{ id: string; root_path: string }>;
    };
    assert.equal(written.projects.length, 1);
    assert.equal(written.projects[0]!.root_path, after);
  });

  it("recovers to an empty registry rather than throwing on a corrupted projects.json", () => {
    const workspace = tempDir("lykos-identity-corrupt-");
    initRepo(workspace);
    const registryDir = tempDir("lykos-identity-registry-");
    const registryPath = join(registryDir, "projects.json");
    writeFileSync(registryPath, "{ this is not valid json", "utf8");

    const result = resolveProject(workspace, { registryPath });
    assert.equal(result.created, true);
    const written = JSON.parse(readFileSync(registryPath, "utf8")) as { projects: unknown[] };
    assert.equal(written.projects.length, 1);
  });
});

describe("auditRegistry (T113)", () => {
  // A LOCAL repo helper, not the shared `initRepo`, and the reason is a real
  // property of git rather than test hygiene: two repositories initialised in
  // the same second with the same author and an identical empty root commit
  // get the SAME first-commit SHA, because that is all a commit hashes. Any
  // audit test that needs two distinct projects must therefore give each one a
  // distinct first commit, or `resolveProject()`'s first-commit fallback will
  // correctly conclude they are one project.
  function initRepoUnique(dir: string, remote: string, marker: string): void {
    git(["init", "-q"], dir);
    writeFileSync(join(dir, "marker.txt"), marker, "utf8");
    git(["add", "marker.txt"], dir);
    git(["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", `init ${marker}`], dir);
    git(["remote", "add", "origin", remote], dir);
  }

  it("reports a registered project whose directory is gone, and never removes it", () => {
    const workspace = tempDir("lykos-audit-gone-");
    initRepoUnique(workspace, "https://example.com/rakun68/gone.git", "gone");
    const registryPath = join(tempDir("lykos-audit-registry-"), "projects.json");
    resolveProject(workspace, { registryPath });

    rmSync(workspace, { recursive: true, force: true });
    const audit = auditRegistry({ registryPath });

    assert.equal(audit.total, 1, "the row survives the directory");
    assert.equal(audit.missingRoot.length, 1);
    assert.equal(audit.missingRoot[0]?.root_path, workspace);
    // A row whose root is gone must not ALSO be reported as ledger-less:
    // that is one fact, not two.
    assert.equal(audit.missingLedger.length, 0);
    // And the file itself still has it — an audit reports, it does not prune.
    const onDisk = JSON.parse(readFileSync(registryPath, "utf8")) as { projects: unknown[] };
    assert.equal(onDisk.projects.length, 1);
  });

  it("separates a project that has never run from one that has", () => {
    const registryPath = join(tempDir("lykos-audit-registry2-"), "projects.json");
    const never = tempDir("lykos-audit-never-");
    initRepoUnique(never, "https://example.com/rakun68/never.git", "never");
    const ran = tempDir("lykos-audit-ran-");
    initRepoUnique(ran, "https://example.com/rakun68/ran.git", "ran");
    mkdirSync(join(ran, ".lykos"), { recursive: true });
    writeFileSync(join(ran, ".lykos", "ledger.db"), "");

    resolveProject(never, { registryPath });
    resolveProject(ran, { registryPath });
    const audit = auditRegistry({ registryPath });

    assert.equal(audit.total, 2);
    assert.equal(audit.missingLedger.length, 1);
    assert.equal(audit.missingLedger[0]?.root_path, never);
  });

  it("finds two rows claiming one identity", () => {
    const registryPath = join(tempDir("lykos-audit-registry3-"), "projects.json");
    const a = tempDir("lykos-audit-dupe-a-");
    initRepoUnique(a, "https://example.com/rakun68/dupe.git", "dupe");
    resolveProject(a, { registryPath });

    // The shape this actually takes in the wild: a second row written for the
    // same remote by an older code path (or by hand), which resolveProject()
    // would never create today but which the file can still contain.
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { projects: Record<string, unknown>[] };
    const clone = { ...registry.projects[0], id: "00000000-0000-4000-8000-000000000000" };
    registry.projects.push(clone);
    writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf8");

    const audit = auditRegistry({ registryPath });
    assert.equal(audit.duplicateIdentities.length, 1);
    assert.equal(audit.duplicateIdentities[0]?.length, 2);
  });

  it("is quiet on a healthy registry", () => {
    const registryPath = join(tempDir("lykos-audit-registry4-"), "projects.json");
    const ws = tempDir("lykos-audit-ok-");
    initRepoUnique(ws, "https://example.com/rakun68/ok.git", "ok");
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(join(ws, ".lykos", "ledger.db"), "");
    resolveProject(ws, { registryPath });

    const audit = auditRegistry({ registryPath });
    assert.equal(audit.total, 1);
    assert.equal(audit.missingRoot.length, 0);
    assert.equal(audit.missingLedger.length, 0);
    assert.equal(audit.duplicateIdentities.length, 0);
  });
});
