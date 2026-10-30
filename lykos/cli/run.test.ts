import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askOutcomeFromEnv, runRun } from "./run.js";

async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, err: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

describe("runRun — argument validation (no process spawned)", () => {
  it("refuses an empty brief without ever spawning the delegate", async () => {
    const { code, err } = await captureStderr(() => runRun(process.cwd(), ""));
    assert.equal(code, 1);
    assert.match(err, /expected a brief/);
  });

  it("refuses an undefined brief the same way", async () => {
    const { code, err } = await captureStderr(() => runRun(process.cwd(), undefined));
    assert.equal(code, 1);
    assert.match(err, /expected a brief/);
  });

  it("refuses a whitespace-only brief the same way", async () => {
    const { code, err } = await captureStderr(() => runRun(process.cwd(), "   "));
    assert.equal(code, 1);
    assert.match(err, /expected a brief/);
  });
});

describe("runRun — containment flags (T180)", () => {
  it("--interactive does not read --containment or --network, and says so rather than ignoring them", async () => {
    for (const opts of [{ containment: "required" as const }, { network: "none" as const }]) {
      const { code, err } = await captureStderr(() => runRun(process.cwd(), undefined, { interactive: true, trustWorkspace: true, ...opts }));
      assert.equal(code, 1);
      assert.match(err, /--containment and --network are not read by --interactive/);
    }
  });
});

describe("runRun — the delegated session's mode and placement flags (T184)", () => {
  it("--interactive does not read --in-place, and says so rather than ignoring it", async () => {
    const { code, err } = await captureStderr(() => runRun(process.cwd(), undefined, { interactive: true, trustWorkspace: true, inPlace: true }));
    assert.equal(code, 1);
    assert.match(err, /--in-place is read by delegated sessions only/);
  });

  it("T209: --interactive accepts --mode and passes it to the interactive session", async () => {
    // If --mode were refused by the interactive guard, runRun would exit 1 with the --in-place refusal.
    // Instead, it proceeds into runInteractive (here caught by an invalid specialist name before any model/ledger interaction).
    const { code, err } = await captureStderr(() =>
      runRun(process.cwd(), undefined, {
        interactive: true,
        trustWorkspace: true,
        mode: "auto",
        specialist: "nonexistent-specialist-for-test",
      }),
    );
    assert.equal(code, 1);
    assert.match(err, /no specialist named "nonexistent-specialist-for-test"/);
    assert.equal(err.includes("--in-place is read by delegated sessions only"), false);
  });
});

// 2026-09-07 (UI feedback item 4): the end-of-session "did that work?"
// question is opt-in. The env half exists so a shell that is deliberately
// exercising the outcome column does not need the flag on every invocation.
describe("askOutcomeFromEnv — the question is off unless asked for", () => {
  it("is off when the variable is absent, empty, or explicitly disabled", () => {
    assert.equal(askOutcomeFromEnv({}), false);
    assert.equal(askOutcomeFromEnv({ LYKOS_ASK_OUTCOME: "" }), false);
    assert.equal(askOutcomeFromEnv({ LYKOS_ASK_OUTCOME: "0" }), false);
    assert.equal(askOutcomeFromEnv({ LYKOS_ASK_OUTCOME: "false" }), false);
    assert.equal(askOutcomeFromEnv({ LYKOS_ASK_OUTCOME: "no" }), false);
  });

  it("is on for anything that reads as a yes", () => {
    assert.equal(askOutcomeFromEnv({ LYKOS_ASK_OUTCOME: "1" }), true);
    assert.equal(askOutcomeFromEnv({ LYKOS_ASK_OUTCOME: "true" }), true);
    assert.equal(askOutcomeFromEnv({ LYKOS_ASK_OUTCOME: "yes" }), true);
  });
});
