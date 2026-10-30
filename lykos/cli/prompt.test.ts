import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildHeadView } from "../session/head-view.js";
import { OUTPUT_DIET_HEADING } from "../loop/prompt-diet.js";
import { SPECIALIST_HEADING } from "../session/specialist-head.js";
import { SKILLS_HEADING } from "../session/skills.js";
import { MOUNTED_CATALOG_HEADING } from "../session/mounted-catalog-head.js";
import {
  PONYTAIL_HEADING,
  PONYTAIL_REPLACE_MARKER,
  resolveSpecialistOverrideHeads,
} from "../session/ponytail-head.js";
import { OFF_LIMITS_HEADING } from "../session/specialist-apply.js";
import { renderHeadView, runPrompt } from "./prompt.js";
import { resetIoMode } from "../tui/io-mode.js";

const HEAD = "deadbeefcafebabe0000000000000000deadbeef";
const ENV: NodeJS.ProcessEnv = {};

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-prompt-cli-"));
  writeFileSync(join(dir, "CLAUDE.md"), "# project rules\nbe brief.\n", "utf8");
  return dir;
}

function writeSkill(dir: string, filename: string, frontmatter: string): void {
  mkdirSync(join(dir, ".lykos", "skills"), { recursive: true });
  writeFileSync(join(dir, ".lykos", "skills", filename), frontmatter, "utf8");
}

describe("renderHeadView", () => {
  it("prints every block heading, the verbatim text, and both fingerprint scopes", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      const text = renderHeadView(view, { fingerprint: "f".repeat(64), sessionId: "sess-1" });
      for (const b of view.blocks) {
        assert.ok(text.includes(b.heading), `missing heading ${b.heading}`);
        assert.ok(text.includes(b.text), `missing verbatim text for ${b.heading}`);
      }
      assert.ok(text.includes(view.fingerprints.bootHead));
      assert.ok(text.includes("f".repeat(64)));
      assert.ok(text.includes("sess-1"));
      assert.ok(text.includes("(pi base)"), "the unreadable half of the head must still be named");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says so plainly when no call has recorded a fingerprint yet", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      assert.match(renderHeadView(view, null), /no call has recorded a prefix fingerprint yet/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows a disabled block as not injected instead of hiding it", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: { LYKOS_OUTPUT_DIET: "0" }, gitHead: HEAD });
      const text = renderHeadView(view, null);
      // T65 added the block's own note beside the flag, because a block can
      // be off for a reason the flag does not name (an empty memory store).
      // The heading and the flag both still have to appear.
      assert.match(text, new RegExp(`${OUTPUT_DIET_HEADING}  — NOT INJECTED \\(.*LYKOS_OUTPUT_DIET=0\\)`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("specialists ticket 01: prints the specialist block verbatim with a real token count", () => {
    const dir = tempProject();
    try {
      const instructions = "Prefer the smallest correct change.";
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD, specialistInstructions: instructions });
      const text = renderHeadView(view, null);
      const block = view.blocks.find((b) => b.heading === SPECIALIST_HEADING);
      assert.ok(block && block.enabled && block.tokens > 0, "the specialist block must be enabled with a nonzero token count");
      assert.ok(text.includes(SPECIALIST_HEADING));
      assert.ok(text.includes(instructions), "the instructions must be printed verbatim, not paraphrased");
      assert.ok(text.includes(String(block!.tokens)), "the block's own token count line must be printed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("specialists ticket 05: prints the loaded-skills block with the roster on the host path", () => {
    const dir = tempProject();
    try {
      writeSkill(dir, "reviewer.md", "---\nname: reviewer\ndescription: review only\n---\n# review\n");
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD, skills: { roster: ["reviewer"] } });
      const text = renderHeadView(view, null);
      const block = view.blocks.find((b) => b.heading === SKILLS_HEADING);
      assert.ok(block && block.enabled && block.tokens > 0, "the skills block must be enabled with a nonzero token count");
      assert.ok(text.includes(SKILLS_HEADING));
      assert.ok(text.includes("<name>reviewer</name>"), "the loaded skill must be printed, not paraphrased");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("P10.2: prints the mounted catalog block with its measured token count", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      const text = renderHeadView(view, null);
      const block = view.blocks.find((b) => b.heading === MOUNTED_CATALOG_HEADING);
      assert.ok(block && block.enabled && block.tokens > 0);
      assert.ok(text.includes(MOUNTED_CATALOG_HEADING));
      assert.ok(text.includes(String(block.tokens)), "the block's own token count line must be printed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runPrompt with specialist inspection", () => {
  async function withCapturedStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
    resetIoMode();
    const original = process.stdout.write.bind(process.stdout);
    let out = "";
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      out += s;
      return true;
    };
    try {
      return { result: await fn(), out };
    } finally {
      (process.stdout as unknown as { write: typeof original }).write = original;
      resetIoMode();
    }
  }

  it("reflects specialist prompt_mode under subagent vs switch without model calls", async () => {
    const dir = tempProject();
    try {
      mkdirSync(join(dir, ".lykos", "specialists"), { recursive: true });
      writeFileSync(
        join(dir, ".lykos", "specialists", "override-spec.yaml"),
        "prompt_mode: override\ninstructions: Custom overriding rules.\n",
        "utf8",
      );
      const subagentRes = await withCapturedStdout(() =>
        runPrompt(dir, { specialist: "override-spec", context: "subagent" }),
      );
      assert.equal(subagentRes.result, 0);
      assert.ok(subagentRes.out.includes(SPECIALIST_HEADING));
      assert.ok(subagentRes.out.includes("Custom overriding rules."));
      assert.ok(!subagentRes.out.includes(PONYTAIL_HEADING), "under subagent, override drops ponytail ruleset");

      const switchRes = await withCapturedStdout(() =>
        runPrompt(dir, { specialist: "override-spec", context: "switch" }),
      );
      assert.equal(switchRes.result, 0);
      assert.ok(switchRes.out.includes(SPECIALIST_HEADING));
      assert.ok(switchRes.out.includes("Custom overriding rules."));
      assert.ok(switchRes.out.includes(PONYTAIL_HEADING), "under switch, override retains ponytail ruleset");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("produces byte-identical prompt output on repeat invocations", async () => {
    const dir = tempProject();
    try {
      mkdirSync(join(dir, ".lykos", "specialists"), { recursive: true });
      writeFileSync(
        join(dir, ".lykos", "specialists", "repeat-spec.yaml"),
        "instructions: Repeatable test instructions.\n",
        "utf8",
      );

      const run1 = await withCapturedStdout(() => runPrompt(dir, { specialist: "repeat-spec" }));
      const run2 = await withCapturedStdout(() => runPrompt(dir, { specialist: "repeat-spec" }));
      assert.equal(run1.result, 0);
      assert.equal(run2.result, 0);
      assert.equal(run1.out, run2.out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("specialists band 2 ticket 07: the inspection agrees with the assembly", () => {
  it("an overriding specialist whose instructions use the ponytail marker keeps its own text", () => {
    // The divergence this guards: `prompt_mode: override` and
    // PONYTAIL_REPLACE_MARKER are two different ways of replacing the default
    // head, and a specialist may declare both. `resolveSpecialistOverrideHeads`
    // routes the marker case back through the marker path, which keeps the
    // `## lykos-ponytail` heading and puts the specialist's text under it. An
    // inspection that dropped every ponytail block whenever the mode said
    // "override" would delete the instructions it exists to show.
    const marked = `${PONYTAIL_REPLACE_MARKER}
Deliberate fully before committing to a shape.`;

    const override = resolveSpecialistOverrideHeads(marked);
    assert.notEqual(override.ponytail, "", "the marker path keeps a ponytail-headed block");
    assert.match(override.ponytail, /Deliberate fully before committing to a shape\./);

    const plainOverride = resolveSpecialistOverrideHeads("Review only. Do not edit.");
    assert.equal(plainOverride.ponytail, "", "without the marker the ponytail block goes");
    assert.match(plainOverride.specialist, /Review only\. Do not edit\./);
  });
});

describe("lykos prompt --target (#47)", () => {
  const cliPath = join(import.meta.dirname, "..", "cli.ts");

  for (const args of [["--target", "delegate"], ["--target=delegate"]]) {
    it(`refuses ${args.join(" ")} and names ADR-0036 rather than ignoring it`, () => {
      // The repo root, so `--import tsx` resolves; the refusal comes before anything reads cwd.
      const res = spawnSync(process.execPath, ["--import", "tsx", cliPath, "prompt", "--show", ...args], {
        cwd: join(import.meta.dirname, "..", ".."),
        encoding: "utf8",
      });
      assert.equal(res.status, 1, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
      assert.match(res.stderr, /--target was removed.*ADR-0036/);
    });
  }
});

describe("lykos prompt --output-style (T217)", () => {
  const cliPath = join(import.meta.dirname, "..", "cli.ts");

  it("shows the ## lykos-output-style block when --output-style minimal is provided", () => {
    const res = spawnSync(process.execPath, ["--import", "tsx", cliPath, "prompt", "--show", "--output-style", "minimal"], {
      cwd: join(import.meta.dirname, "..", ".."),
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /## lykos-output-style/);
    assert.match(res.stdout, /reply shape \(minimal\)/);
  });

  it("fails with the same OutputStyleNotFoundError boot raises when an unknown output style is passed", () => {
    const res = spawnSync(process.execPath, ["--import", "tsx", cliPath, "prompt", "--show", "--output-style", "nonexistent"], {
      cwd: join(import.meta.dirname, "..", ".."),
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /OutputStyleNotFoundError/);
    assert.match(res.stderr, /lykos: no output style named "nonexistent" — available output styles:/);
  });
});
