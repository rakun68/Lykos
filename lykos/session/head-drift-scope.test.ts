import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOOT_HEADING, HeadContract, lykosOwnedRegion, type BootArtifacts } from "./head-contract.js";

const ARTIFACTS: BootArtifacts = {
  cwd: "/repo",
  platform: "linux",
  project: "repo",
  gitHeadAtBoot: "abc1234",
  toolNames: ["read", "bash", "edit", "write"],
};

function promptWith(lykosBlock: string, contextFiles: string): string {
  return `You are pi.\n\n${lykosBlock}\n\n<project_context>\n${contextFiles}\n</project_context>`;
}

describe("T90 lykosOwnedRegion", () => {
  it("excludes the ingested context files", () => {
    const prompt = promptWith(`${BOOT_HEADING}\ncwd: /repo`, "run `git status` before committing");
    const region = lykosOwnedRegion(prompt);
    assert.ok(region.includes("cwd: /repo"));
    assert.ok(!region.includes("git status"), "a CLAUDE.md that mentions git status is not head churn");
  });

  it("excludes Pi's own base prompt before the boot heading", () => {
    const prompt = promptWith(`${BOOT_HEADING}\ncwd: /repo`, "");
    assert.ok(!lykosOwnedRegion(prompt).includes("You are pi."));
  });

  it("falls back to the whole prompt when there is no Lykos head", () => {
    assert.equal(lykosOwnedRegion("no head here"), "no head here");
  });
});

describe("T90 drift detection no longer fires on context-file text", () => {
  function observe(contextFiles: string): string[] {
    const contract = new HeadContract();
    const boot = contract.boot(ARTIFACTS);
    const prompt = promptWith(boot.bootHead, contextFiles);
    return contract.observe(prompt, [...ARTIFACTS.toolNames]).driftedFields;
  }

  it("stays quiet when only a context file mentions git status", () => {
    const drifted = observe("The single repeated command in the archive is `git status && git log`.");
    assert.deepEqual(
      drifted.filter((f) => f.startsWith("volatile:")),
      [],
      "this repo's own CLAUDE.md contains that phrase and every session reported drift because of it",
    );
  });

  it("still reports genuinely volatile content inside the Lykos head", () => {
    const contract = new HeadContract();
    const boot = contract.boot(ARTIFACTS);
    const tampered = `${boot.bootHead}\ngit status: 3 files changed`;
    const drifted = contract.observe(promptWith(tampered, ""), [...ARTIFACTS.toolNames]).driftedFields;
    assert.ok(
      drifted.some((f) => f === "volatile:git-status"),
      "real churn in the head Lykos owns must still be caught",
    );
  });
});
