import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  buildRepoMap,
  cachePath,
  DEFAULT_MAX_TOKENS,
  emptyRepoMap,
  rankDirectories,
  renderRepoMap,
  REPO_MAP_HEADING,
  resolveRepoMapPolicy,
  scoreFile,
  sourceHash,
  trackedFiles,
} from "./repo-map.js";

const f = (path: string, churn = 0) => ({ path, churn });

function gitRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-repo-map-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  run("init", "-q");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "T");
  run("add", "-A");
  run("commit", "-qm", "init");
  return dir;
}

describe("resolveRepoMapPolicy (T69)", () => {
  it("is off unless the caller enables it (T158: because lykos-repo-map is declared)", () => {
    assert.equal(resolveRepoMapPolicy(undefined).enabled, false);
    assert.equal(resolveRepoMapPolicy({}).enabled, false);
    assert.equal(resolveRepoMapPolicy({ enabled: false }).enabled, false);
    assert.equal(resolveRepoMapPolicy({ enabled: true }).enabled, true);
  });

  it("T158: has no environment switch — the extension list is the only one", () => {
    process.env.LYKOS_REPO_MAP = "0";
    try {
      assert.equal(resolveRepoMapPolicy({ enabled: true }).enabled, true);
    } finally {
      delete process.env.LYKOS_REPO_MAP;
    }
  });

  it("falls back to a cap below problems/06's 2000-token failure threshold", () => {
    assert.equal(resolveRepoMapPolicy({ enabled: true }).maxTokens, DEFAULT_MAX_TOKENS);
    assert.ok(DEFAULT_MAX_TOKENS < 2000, "the default cap must sit under the early-warning signal");
    assert.equal(resolveRepoMapPolicy({ enabled: true, max_tokens: 0 }).maxTokens, DEFAULT_MAX_TOKENS);
    assert.equal(resolveRepoMapPolicy({ enabled: true, max_tokens: 400 }).maxTokens, 400);
  });
});

describe("scoreFile (T69)", () => {
  it("ranks an entry point above a hot file", () => {
    assert.ok(scoreFile(f("src/index.ts")) > scoreFile(f("src/helpers.ts", 40)));
  });

  it("ranks a churning file above a quiet one", () => {
    assert.ok(scoreFile(f("src/a.ts", 20)) > scoreFile(f("src/b.ts", 0)));
  });

  it("caps churn so one hot file cannot outrank an entry point", () => {
    assert.ok(scoreFile(f("src/index.ts")) > scoreFile(f("src/hot.ts", 10_000)));
  });

  it("ranks a test file below its subject", () => {
    assert.ok(scoreFile(f("src/session.ts")) > scoreFile(f("src/session.test.ts")));
  });

  it("ranks a shallow file above a deep one, all else equal", () => {
    assert.ok(scoreFile(f("a.ts")) > scoreFile(f("a/b/c/d/a.ts")));
  });

  it("pushes generated and vendored directories to the bottom", () => {
    assert.ok(scoreFile(f("src/a.ts")) > scoreFile(f("dist/a.ts")));
    assert.ok(scoreFile(f("src/index.ts")) > scoreFile(f("node_modules/x/index.ts")));
  });
});

describe("rankDirectories (T69)", () => {
  it("groups by directory and keeps the top N per directory", () => {
    const entries = rankDirectories(
      [f("src/index.ts"), f("src/a.ts", 5), f("src/b.ts"), f("src/c.ts"), f("docs/readme.md")],
      2,
    );
    const src = entries.find((e) => e.dir === "src");
    assert.equal(src?.files.length, 2);
    assert.equal(src?.totalFiles, 4);
    assert.equal(src?.omitted, 2);
    assert.equal(src?.files[0]?.path, "src/index.ts");
  });

  it("puts the directory containing the entry point first", () => {
    const entries = rankDirectories([f("zzz/notes.md"), f("src/index.ts")], 6);
    assert.equal(entries[0]?.dir, "src");
  });

  it("is deterministic — the same input yields the same order", () => {
    const files = [f("b/x.ts"), f("a/x.ts"), f("c/index.ts")];
    assert.deepEqual(
      rankDirectories(files, 6).map((e) => e.dir),
      rankDirectories([...files].reverse(), 6).map((e) => e.dir),
    );
  });

  it("files at the repo root land in `.`", () => {
    assert.equal(rankDirectories([f("README.md")], 6)[0]?.dir, ".");
  });
});

describe("renderRepoMap (T69)", () => {
  const entries = (n: number) =>
    rankDirectories(
      Array.from({ length: n }, (_, i) => f(`dir${String(i).padStart(3, "0")}/file.ts`)),
      6,
    );

  it("emits the heading, the counts and one line per directory", () => {
    const map = renderRepoMap(rankDirectories([f("src/index.ts"), f("src/a.ts")], 6), 2, 1500);
    assert.ok(map.text.startsWith(REPO_MAP_HEADING));
    assert.match(map.text, /2 tracked files/);
    assert.match(map.text, /src\/\s+index\.ts a\.ts/);
    assert.equal(map.files, 2);
    assert.equal(map.dropped, 0);
  });

  it("says the map is frozen, so the model does not treat it as live", () => {
    const map = renderRepoMap(rankDirectories([f("a.ts")], 6), 1, 1500);
    assert.match(map.text, /frozen for this session/);
  });

  it("stays inside the cap and names how many files it did not list", () => {
    const map = renderRepoMap(entries(400), 400, 300);
    assert.ok(map.tokens <= 300, `tokens ${map.tokens} exceeded the cap`);
    assert.ok(map.dropped > 0);
    assert.match(map.text, /more files not listed here/);
    assert.ok(map.droppedDirs > 0);
  });

  it("counts files hidden by the per-directory cap as dropped too", () => {
    const many = Array.from({ length: 20 }, (_, i) => f(`src/f${i}.ts`));
    const map = renderRepoMap(rankDirectories(many, 3), 20, 1500);
    assert.equal(map.files, 3);
    assert.equal(map.dropped, 17);
    assert.match(map.text, /\(\+17 more\)/);
  });

  it("emits nothing at all rather than a heading with no directories", () => {
    const map = renderRepoMap(entries(50), 50, 5);
    assert.equal(map.text, "");
    assert.equal(map.files, 0);
    assert.equal(map.dropped, 50);
  });

  it("emits nothing on an empty repo", () => {
    const map = renderRepoMap([], 0, 1500);
    assert.equal(map.text, "");
  });

  it("never truncates a line — every rendered directory is complete", () => {
    const map = renderRepoMap(entries(200), 200, 400);
    for (const line of map.text.split("\n").slice(3)) {
      if (line.includes("not listed here")) continue;
      assert.match(line, /\/ /, `line was cut: ${line}`);
    }
  });
});

describe("buildRepoMap (T69) — against a real git repo", () => {
  it("reads tracked files, ranks them, and caches the result", () => {
    const dir = gitRepo({
      "src/index.ts": "export const a = 1;\n",
      "src/util.ts": "export const b = 2;\n",
      "docs/guide.md": "# guide\n",
      "README.md": "# repo\n",
    });
    try {
      const policy = { enabled: true, maxTokens: 1500, maxFilesPerDir: 6 };
      const map = buildRepoMap(dir, policy);
      assert.equal(map.enabled, true);
      assert.equal(map.tracked, 4);
      assert.match(map.text, /src\//);
      assert.match(map.text, /index\.ts/);
      assert.ok(map.sourceHash.length > 0);
      assert.ok(map.tokens > 0 && map.tokens <= 1500);

      // Second call comes off the cache and is byte-identical.
      const again = buildRepoMap(dir, policy);
      assert.equal(again.text, map.text);
      assert.ok(cachePath(dir).endsWith(join(".lykos", "cache", "repo-map.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalidates when a file is added — the source hash is content, not clock", () => {
    const dir = gitRepo({ "a.ts": "1\n" });
    try {
      const policy = { enabled: true, maxTokens: 1500, maxFilesPerDir: 6 };
      const first = buildRepoMap(dir, policy);
      writeFileSync(join(dir, "b.ts"), "2\n", "utf8");
      execFileSync("git", ["add", "-A"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
      const second = buildRepoMap(dir, policy);
      assert.notEqual(second.sourceHash, first.sourceHash);
      assert.equal(second.tracked, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT invalidate when a tracked file's contents change — the map does not show contents", () => {
    const dir = gitRepo({ "a.ts": "1\n" });
    try {
      const policy = { enabled: true, maxTokens: 1500, maxFilesPerDir: 6 };
      const first = buildRepoMap(dir, policy);
      writeFileSync(join(dir, "a.ts"), "// rewritten entirely\n", "utf8");
      const second = buildRepoMap(dir, policy);
      assert.equal(second.sourceHash, first.sourceHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds when the token cap changes, so a config edit is not silently ignored", () => {
    const dir = gitRepo({ "src/index.ts": "1\n", "src/a.ts": "2\n", "src/b.ts": "3\n" });
    try {
      const wide = buildRepoMap(dir, { enabled: true, maxTokens: 1500, maxFilesPerDir: 6 });
      const narrow = buildRepoMap(dir, { enabled: true, maxTokens: 40, maxFilesPerDir: 6 });
      assert.notEqual(narrow.text, wide.text);
      assert.ok(narrow.tokens <= 40);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty, disabled map when the policy is off — and does not touch git", () => {
    const dir = gitRepo({ "a.ts": "1\n" });
    try {
      const map = buildRepoMap(dir, { enabled: false, maxTokens: 1500, maxFilesPerDir: 6 });
      assert.deepEqual(map, emptyRepoMap(false));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("produces no map outside a git repository rather than guessing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-no-git-"));
    try {
      writeFileSync(join(dir, "a.ts"), "1\n", "utf8");
      assert.equal(trackedFiles(dir), null);
      assert.equal(buildRepoMap(dir, { enabled: true, maxTokens: 1500, maxFilesPerDir: 6 }).text, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes .lykos at ANY depth, not just the root", () => {
    // Found by running the map against this repository: sixteen lines of it
    // were `lykos_testing_env/.lykos/session/<uuid>/` directories, each
    // rendering an identical `live.json meta.json summary.txt
    // transcript.jsonl`. A root-anchored exclusion missed all of them.
    const dir = gitRepo({
      "src/index.ts": "1\n",
      ".lykos/cache/repo-map.json": "{}\n",
      "sub/.lykos/session/abc/transcript.jsonl": "{}\n",
      "sub/.lykos/session/def/transcript.jsonl": "{}\n",
    });
    try {
      const files = trackedFiles(dir);
      assert.deepEqual(files, ["src/index.ts"]);
      const map = buildRepoMap(dir, { enabled: true, maxTokens: 1500, maxFilesPerDir: 6 });
      assert.equal(map.tracked, 1);
      assert.equal(map.text.includes(".lykos"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives a corrupt cache by rebuilding", () => {
    const dir = gitRepo({ "src/index.ts": "1\n" });
    try {
      const policy = { enabled: true, maxTokens: 1500, maxFilesPerDir: 6 };
      buildRepoMap(dir, policy);
      mkdirSync(dirname(cachePath(dir)), { recursive: true });
      writeFileSync(cachePath(dir), "{ not json", "utf8");
      assert.match(buildRepoMap(dir, policy).text, /index\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hashes HEAD as well as the file list, so a commit invalidates", () => {
    const dir = gitRepo({ "a.ts": "1\n" });
    try {
      const before = sourceHash(dir, ["a.ts"]);
      writeFileSync(join(dir, "a.ts"), "2\n", "utf8");
      execFileSync("git", ["commit", "-aqm", "change"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
      assert.notEqual(sourceHash(dir, ["a.ts"]), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
