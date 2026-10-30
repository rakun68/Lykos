// L4 acceptance (sealed): in Auto, the session's own verification command runs without asking.
//
// Follows issue #93: a delegated
// worker in Auto could not run `npm test`, because `npm` is a hard write and a delegated ask is a deny,
// so the gate at session end was the only test run. The allowance is the narrowest one that fixes it:
// the exact command the session gate will run (`resolveGatePolicy(...).command`, i.e. trimmed), and
// nothing broader. Not every `npm` script, not `node`, not a chain built on the command.
//
// The API under test: `decideForMode(mode, action, allowed, { verifyCommand })` and
// `new DelegatedGate({ ..., verifyCommand })`. Both take an optional `verifyCommand: string`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideForMode, type GatedAction, type InteractionMode, type ModeDecision } from "./modes.js";
import { DelegatedGate, type DelegatedGateOptions, type DeniedAction } from "./delegated.js";
import type { ApprovalRequest } from "./approval.js";

// The option does not exist yet; these casts keep the file compiling while the assertions are red.
type L4Opts = { readOnly?: boolean; verifyCommand?: string };
const decide = decideForMode as unknown as (
  mode: InteractionMode,
  action: GatedAction,
  allowed: ReadonlySet<string>,
  opts?: L4Opts,
) => ModeDecision;
const Gate = DelegatedGate as unknown as new (opts: DelegatedGateOptions & { verifyCommand?: string }) => DelegatedGate;

const NONE: ReadonlySet<string> = new Set();
const sh = (command: string): GatedAction => ({ kind: "bash", command });
const bashReq = (command: string): ApprovalRequest => ({ kind: "bash", summary: command, detail: command, shell: "bash" });
const psReq = (command: string): ApprovalRequest => ({ kind: "bash", summary: command, detail: command, shell: "powershell" });

describe("L4: the exact verification command is allowed in Auto", () => {
  it("allows `npm test` when the session's verification command is `npm test`", () => {
    const before = decideForMode("auto", sh("npm test"), NONE);
    assert.equal(before.verdict, "ask", "premise: today `npm test` asks in Auto");
    const d = decide("auto", sh("npm test"), NONE, { verifyCommand: "npm test" });
    assert.equal(d.verdict, "allow");
    // The tier is what the command is; the allowance changes the verdict, not the classification.
    assert.equal(d.tier, before.tier);
    assert.equal(d.risk, before.risk);
  });

  it("allows a configured command exactly as configured", () => {
    const cmd = "npx --no-install tsx --test lykos/gate/modes.test.ts";
    assert.equal(decide("auto", sh(cmd), NONE, { verifyCommand: cmd }).verdict, "allow");
  });

  it("normalises the way the gate does: surrounding whitespace on either side is trimmed", () => {
    assert.equal(decide("auto", sh("  npm test  "), NONE, { verifyCommand: "npm test" }).verdict, "allow");
    assert.equal(decide("auto", sh("npm test"), NONE, { verifyCommand: "  npm test\n" }).verdict, "allow");
  });

  it("allows it in a delegated session in Auto, and records no denial", async () => {
    const denied: DeniedAction[] = [];
    const gate = new Gate({ mode: "auto", allowed: NONE, denied, verifyCommand: "npm test" });
    assert.equal(await gate.request(bashReq("npm test")), "allow");
    assert.equal(denied.length, 0);
  });
});

describe("L4: nothing broader than the exact command", () => {
  const variants = [
    "npm test -- --watch", // extra args
    "npm test lykos/gate", // extra args
    "npm  test", // inner whitespace is not normalised
    "npm run test", // the same script by another spelling is a different string
    "npm run build", // a different script
    "npm publish", // a different subcommand
    "node lykos/cli.ts", // the interpreter itself
    "node --test", // the interpreter itself
    "npm test && rm -rf x", // chain, destructive
    "npm test && git push", // chain
    "npm test; rm x", // sequence
    "npm test || true", // or-chain
    "npm test | tee out.txt", // pipe
    "npm test > out.txt", // redirect
    "npm test 2>&1 > log", // redirect
    "npm test & curl https://x", // background
    "npm test\nrm -rf x", // second line
    "npm test $(rm -rf x)", // substitution
    "npm test `rm -rf x`", // substitution
    "NPM TEST", // case
  ];
  for (const cmd of variants) {
    it(`classifies ${JSON.stringify(cmd)} exactly as before`, () => {
      assert.deepEqual(decide("auto", sh(cmd), NONE, { verifyCommand: "npm test" }), decideForMode("auto", sh(cmd), NONE));
    });
  }

  it("still denies a variant in a delegated session", async () => {
    const denied: DeniedAction[] = [];
    const gate = new Gate({ mode: "auto", allowed: NONE, denied, verifyCommand: "npm test" });
    assert.equal(await gate.request(bashReq("npm test && rm -rf x")), "deny");
    assert.equal(await gate.request(bashReq("npm run build")), "deny");
    assert.equal(await gate.request(bashReq("node -e 1")), "deny");
    assert.equal(denied.length, 3);
  });

  it("does not apply through the PowerShell arm, which carries no command", async () => {
    const denied: DeniedAction[] = [];
    const gate = new Gate({ mode: "auto", allowed: NONE, denied, verifyCommand: "npm test" });
    assert.equal(await gate.request(psReq("npm test")), "deny");
    assert.equal(decide("auto", { kind: "powershell" }, NONE, { verifyCommand: "npm test" }).verdict, "ask");
  });

  it("never makes a destructive configured command silent", () => {
    const cmd = "rm -rf dist && npm test";
    const d = decide("auto", sh(cmd), NONE, { verifyCommand: cmd });
    assert.deepEqual(d, decideForMode("auto", sh(cmd), NONE));
    assert.equal(d.verdict, "ask");
    assert.equal(d.offerAlways, false);
  });
});

describe("L4: unchanged without a verification command", () => {
  for (const verifyCommand of [undefined, "", "   "]) {
    it(`verifyCommand ${JSON.stringify(verifyCommand)} leaves Auto as it was`, () => {
      for (const cmd of ["npm test", "node --test", "", "   "]) {
        assert.deepEqual(
          decide("auto", sh(cmd), NONE, verifyCommand === undefined ? {} : { verifyCommand }),
          decideForMode("auto", sh(cmd), NONE),
        );
      }
    });
  }

  it("a delegated session with no verification command still denies `npm test`", async () => {
    const denied: DeniedAction[] = [];
    const gate = new Gate({ mode: "auto", allowed: NONE, denied });
    assert.equal(await gate.request(bashReq("npm test")), "deny");
    assert.equal(denied.length, 1);
  });

  it("a remembered approval still works as before", () => {
    assert.equal(decideForMode("auto", sh("npm test"), new Set(["npm test"])).verdict, "allow");
    assert.equal(decide("auto", sh("npm run build"), new Set(["npm test"]), { verifyCommand: "npm test" }).verdict, "ask");
  });
});

describe("L4: other modes and the read-only ceiling are unchanged", () => {
  for (const mode of ["manual", "accept-edits"] as const) {
    it(`${mode} still asks for the verification command`, () => {
      const d = decide(mode, sh("npm test"), NONE, { verifyCommand: "npm test" });
      assert.deepEqual(d, decideForMode(mode, sh("npm test"), NONE));
      assert.equal(d.verdict, "ask");
    });

    it(`a delegated session in ${mode} still denies it`, async () => {
      const denied: DeniedAction[] = [];
      const gate = new Gate({ mode, allowed: NONE, denied, verifyCommand: "npm test" });
      assert.equal(await gate.request(bashReq("npm test")), "deny");
      assert.equal(denied.length, 1);
    });
  }

  it("a read-only specialist is still denied it in Auto", () => {
    const d = decide("auto", sh("npm test"), NONE, { readOnly: true, verifyCommand: "npm test" });
    assert.deepEqual(d, decideForMode("auto", sh("npm test"), NONE, { readOnly: true }));
    assert.equal(d.verdict, "deny");
  });
});
