// T250: the result contract's new values, and the flags that need only git's view of a change.
// Lessons F4 (SENSITIVE on real names, never "lock" as a substring), W1 and worker_scope_creep
// (OUT-OF-SCOPE against `scope`) each have a regression test here.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { leftoverSubject } from "../git/worktree.js";
import { addedLines, changeFlags, isSensitivePath, outOfScopePaths, parseNameStatus } from "./result-flags.js";
import { parseFrame, parseRequest, PROTOCOL_VERSION } from "./session-protocol.js";
import { watchStepCap, type StepCappable } from "./step-cap.js";

describe("T250: SENSITIVE is decided on real file names (F4)", () => {
  const sensitive = [
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "Cargo.lock",
    "Cargo.toml",
    "poetry.lock",
    "gradle.lockfile",
    "app/build.gradle.kts",
    "gradle/wrapper/gradle-wrapper.properties",
    "requirements-dev.txt",
    "Dockerfile",
    "docker/api.Dockerfile",
    ".github/workflows/ci.yml",
    ".gitlab-ci.yml",
    "scripts/release.mjs",
    "db/migrations/0001_init.sql",
    "tools/setup.sh",
    ".env.local",
    "tsconfig.build.json",
    "go.sum",
  ];
  const ordinary = [
    "src/clock.ts",
    "src/my-lock.ts",
    "src/lockfile-reader.ts",
    "src/locked-queue.ts",
    "src/blocks/Block.java",
    "docs/unlock.md",
    "src/environment.ts",
    "src/scripts.ts",
    "README.md",
  ];
  for (const path of sensitive) it(`${path} is sensitive`, () => assert.equal(isSensitivePath(path), true));
  for (const path of ordinary) it(`${path} is not`, () => assert.equal(isSensitivePath(path), false));

  it("a project's extra pattern adds paths", () => {
    assert.equal(isSensitivePath("infra/main.tf", /^infra\//), true);
  });

  it("a deleted file is sensitive whatever its name", () => {
    const flags = changeFlags({ sessionId: "s1", changed: [{ status: "D", path: "src/a.ts" }], added: [] });
    const f = flags.find((x) => x.flag === "SENSITIVE");
    assert.ok(f);
    assert.match(f.detail, /src\/a\.ts \(deleted\)/);
  });
});

describe("T250: OUT-OF-SCOPE against the task's scope globs (worker_scope_creep)", () => {
  const changed = parseNameStatus("M\tsrc/a.ts\nM\tdocs/guide.md\nA\tsrc/new.ts\nM\tsrc/other.test.ts\n");

  it("a changed file outside every glob is out of scope", () => {
    assert.deepEqual(outOfScopePaths({ changed, scope: ["src/**"] }), ["docs/guide.md"]);
  });

  it("no scope checks nothing", () => {
    assert.deepEqual(outOfScopePaths({ changed }), []);
    assert.deepEqual(outOfScopePaths({ changed, scope: [] }), []);
  });

  it("a new file beside one of the task's files is in scope", () => {
    assert.deepEqual(outOfScopePaths({ changed, scope: ["src/a.ts"], files: ["src/a.ts"], removedLines: new Map() }), ["docs/guide.md", "src/other.test.ts"]);
  });

  it("a test file that only gains lines is in scope", () => {
    const removed = new Map([["src/other.test.ts", 0]]);
    assert.deepEqual(outOfScopePaths({ changed, scope: ["src/a.ts"], files: ["src/a.ts"], removedLines: removed }), ["docs/guide.md"]);
  });

  it("the flag names the files and the session", () => {
    const [f] = changeFlags({ sessionId: "sess-9", changed, added: [], scope: ["src/**"] });
    assert.equal(f?.flag, "OUT-OF-SCOPE");
    assert.deepEqual(f?.files, ["docs/guide.md"]);
    assert.equal(f?.session, "sess-9");
  });
});

describe("T250: STAND-IN and LEFTOVERS (W1)", () => {
  it("a skipped or focused test added by the change is a stand-in", () => {
    const added = addedLines("+++ b/x.test.ts\n+  it.skip('works', () => {});\n+  const y = 1;\n-  it('works', () => {});\n");
    const f = changeFlags({ sessionId: "s", changed: [], added }).find((x) => x.flag === "STAND-IN");
    assert.ok(f);
    assert.match(f.detail, /it\.skip/);
    assert.equal(f.session, "s");
  });

  it("an ordinary line is not", () => {
    assert.equal(changeFlags({ changed: [], added: ["const skipped = items.filter(isDone);"] }).length, 0);
  });

  it("the commit that saved leftovers raises LEFTOVERS", () => {
    const commits = [{ sha: "abcdef0123456789", subject: leftoverSubject("s2") }];
    const f = changeFlags({ sessionId: "s2", changed: [], added: [], commits }).find((x) => x.flag === "LEFTOVERS");
    assert.ok(f);
    assert.match(f.detail, /abcdef012345/);
  });
});

describe("T250: the request and result still parse", () => {
  const base = { version: PROTOCOL_VERSION, tool: "lykos_implement", workspace: "/w", prompt: "p", label: "l" };

  it("an old request parses unchanged", () => {
    assert.deepEqual(parseRequest(JSON.stringify(base)), base);
  });

  it("max_steps and request_id parse when valid and refuse otherwise", () => {
    assert.equal(parseRequest(JSON.stringify({ ...base, maxSteps: 3, requestId: "cycle-1/step-2" }))?.maxSteps, 3);
    assert.equal(parseRequest(JSON.stringify({ ...base, maxSteps: 0 })), undefined);
    assert.equal(parseRequest(JSON.stringify({ ...base, maxSteps: 1.5 })), undefined);
    assert.equal(parseRequest(JSON.stringify({ ...base, requestId: "" })), undefined);
  });

  it("an old result and a result with a new token and flag both parse", () => {
    assert.ok(parseFrame(JSON.stringify({ type: "result", result: { outcome: "ok", sessionId: "s", next: "review_or_accept" } })));
    const frame = parseFrame(
      JSON.stringify({ type: "result", result: { outcome: "ok", sessionId: "s", next: "approve", flags: [{ flag: "WEAK-SPEC", detail: "d", session: "s" }] } }),
    );
    assert.equal(frame?.type, "result");
  });
});

describe("T250: the step cap", () => {
  function fakeSession(): StepCappable & { emit: (e: AgentSessionEvent) => void; aborted: number } {
    let listener: ((e: AgentSessionEvent) => void) | undefined;
    const s = {
      aborted: 0,
      subscribe: (l: (e: AgentSessionEvent) => void) => {
        listener = l;
        return () => (listener = undefined);
      },
      abort: async () => {
        s.aborted += 1;
      },
      emit: (e: AgentSessionEvent) => listener?.(e),
    };
    return s;
  }
  const turnEnd = { type: "turn_end" } as AgentSessionEvent;

  it("aborts once, at the cap's turn, and not before", () => {
    const s = fakeSession();
    let capped = 0;
    watchStepCap(s, 2, () => (capped += 1));
    s.emit(turnEnd);
    assert.equal(s.aborted, 0);
    s.emit({ type: "agent_settled" } as AgentSessionEvent);
    s.emit(turnEnd);
    assert.equal(s.aborted, 1);
    s.emit(turnEnd);
    assert.equal(s.aborted, 1);
    assert.equal(capped, 1);
  });
});
