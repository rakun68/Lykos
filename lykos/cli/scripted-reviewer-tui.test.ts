// T162: the reviewer's end-of-session report in the terminal UI. The same
// scripted model drives `runInteractiveStandaloneSession` — the entry
// `lykos` with no arguments reaches — through a scripted line source, and
// what the person sees is whatever the session writes after `/exit`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AutoApproveGate } from "../gate/approval.js";
import { runInteractiveStandaloneSession, type LineSource } from "../session/interactive.js";
import { call, reply, say, SCRIPTED_MODEL, scriptedWorld } from "./scripted-session.js";

/** Types each line in turn, then ends input. */
class Lines implements LineSource {
  constructor(private readonly lines: string[]) {}
  async next(): Promise<string | null> {
    return this.lines.shift() ?? null;
  }
  close(): void {
    this.lines.length = 0;
  }
}

/** Runs `fn`, recording what it writes to stderr and stdout while still passing it through. */
async function tee<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let text = "";
  const record =
    (write: typeof process.stdout.write) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      text += String(chunk);
      return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = record(out);
  process.stderr.write = record(err);
  try {
    return { value: await fn(), text };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

describe("lykos-reviewer in the terminal UI (T162)", () => {
  it("prints the count and the top findings right after the gate's verdict", async () => {
    const world = await scriptedWorld({
      files: { "src/sum.ts": "export const sum = (a: number, b: number) => a + b;\n" },
      config: `reviewer:\n  enabled: true\ngate:\n  command: ${JSON.stringify(`node -e "process.exit(0)"`)}\n`,
      script: [
        reply(call("write", { path: "src/sum.ts", content: "export const sum = (a: number, b: number) => a * b;\n" })),
        reply(say("done")),
        // The reviewer's read-only child.
        reply(say("FINDING: sum multiplies instead of adding\nFINDING: no test covers sum")),
      ],
    });
    const { value: result, text } = await tee(() =>
      runInteractiveStandaloneSession({
        workspace: world.workspace,
        ledgerPath: world.ledgerPath,
        model: SCRIPTED_MODEL,
        nativeProviders: [world.provider],
        lineSource: new Lines(["Do the scripted task.", "/exit"]),
        approvalGate: new AutoApproveGate(),
      }),
    );
    world.check();
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(world.unusedSteps(), 0);
    assert.equal(world.modelCalls(), 3);
    assert.equal(readFileSync(join(world.workspace, "src/sum.ts"), "utf8").includes("a * b"), true);

    // The gate says it is running before it runs (P4 demo run 1, 2026-10-05).
    const started = text.indexOf("lykos gate: running `");
    const verdict = text.indexOf("PASSED (exit 0)");
    assert.ok(started >= 0 && started < verdict, `the gate announced itself before its verdict:\n${text}`);
    const report = text.indexOf("lykos-reviewer: 2 finding(s) on faux/scripted-1, advisory:");
    assert.ok(verdict >= 0, `the gate printed its verdict:\n${text}`);
    assert.ok(report > verdict, `the reviewer's report follows the verdict:\n${text}`);
    const after = text.slice(report);
    assert.match(after, /1\. sum multiplies instead of adding/);
    assert.match(after, /2\. no test covers sum/);
    assert.match(after, /full text: `lykos show [^`]+`/);
  });
});
