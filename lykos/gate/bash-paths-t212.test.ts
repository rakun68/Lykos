// T212 acceptance (sealed): path rules reach file commands in bash and redirects (ADR-0042).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commandPathAccesses, decideCommandPaths, pathRuleEnforcement } from "./bash-paths.js";
import { collectPathRules, decidePath, type PathContext } from "./path-rules.js";

const CTX: PathContext = { cwd: "/work/proj", home: "/home/u", extraDirs: [], outside: { read: "ask", write: "ask" } };
const RULES = () => collectPathRules({}, false);

describe("T212: which paths a command names", () => {
  it("reads for cat, head, tail and sed, writes for tee and sed -i", () => {
    assert.deepEqual(commandPathAccesses("cat .env"), [{ path: ".env", access: "read" }]);
    assert.deepEqual(commandPathAccesses("head -n 5 a.txt"), [{ path: "a.txt", access: "read" }]);
    assert.deepEqual(commandPathAccesses("tail -f log/app.log"), [{ path: "log/app.log", access: "read" }]);
    assert.deepEqual(commandPathAccesses("sed -n 1,5p src/a.ts"), [{ path: "src/a.ts", access: "read" }]);
    assert.deepEqual(commandPathAccesses("sed -i s/a/b/ src/a.ts"), [{ path: "src/a.ts", access: "write" }]);
    assert.deepEqual(commandPathAccesses("echo x | tee out.txt"), [{ path: "out.txt", access: "write" }]);
  });

  it("covers > >> and < redirect targets across segments", () => {
    const got = commandPathAccesses("echo x > .git/config && sort < in.txt >> out.txt");
    assert.deepEqual(
      [...got].sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: ".git/config", access: "write" },
        { path: "in.txt", access: "read" },
        { path: "out.txt", access: "write" },
      ],
    );
  });

  it("claims nothing it cannot see", () => {
    assert.deepEqual(commandPathAccesses("grep -r TODO ."), []);
    assert.deepEqual(commandPathAccesses("node scripts/build.js"), []);
    assert.deepEqual(commandPathAccesses("echo x 2>&1"), []);
  });
});

describe("T212: the command decision matches the file tools", () => {
  it("cat .env is denied exactly as a read of .env is", () => {
    const tool = decidePath("/work/proj/.env", "read", RULES(), CTX);
    const cmd = decideCommandPaths("cat .env", RULES(), CTX);
    assert.equal(cmd.decision, "deny");
    assert.equal(cmd.decision, tool.decision);
    assert.equal(cmd.rule, tool.rule);
  });

  it("echo x > .git/config asks, protected, exactly as a write of it does", () => {
    const tool = decidePath("/work/proj/.git/config", "write", RULES(), CTX);
    const cmd = decideCommandPaths("echo x > .git/config", RULES(), CTX);
    assert.equal(cmd.decision, "ask");
    assert.equal(cmd.decision, tool.decision);
    assert.equal(cmd.protected, true);
  });

  it("the strictest named path wins", () => {
    assert.equal(decideCommandPaths("cat README.md .env", RULES(), CTX).decision, "deny");
    assert.equal(decideCommandPaths("cat /etc/hosts", RULES(), CTX).decision, "ask");
  });

  it("grep -r from the directory is allowed and not claimed as covered", () => {
    const d = decideCommandPaths("grep -r TODO .", RULES(), CTX);
    assert.equal(d.decision, "allow");
    assert.equal(d.covered, false);
    assert.equal(decideCommandPaths("cat README.md", RULES(), CTX).covered, true);
  });
});

describe("T212: how much Lykos guarantees", () => {
  it("is enforced under containment and best effort on the host", () => {
    assert.equal(pathRuleEnforcement(true), "enforced");
    assert.equal(pathRuleEnforcement(false), "best effort");
  });
});
