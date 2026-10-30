// T211 acceptance (sealed): secret and protected paths, on the host and in the container (ADR-0042).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectPathRules, containmentPathPlan, decidePath, shippedPathRules, type PathContext } from "./path-rules.js";

const CTX: PathContext = { cwd: "/work/proj", home: "/home/u", extraDirs: [], outside: { read: "ask", write: "ask" } };
const SHIPPED = () => collectPathRules({}, false);

describe("T211: shipped secret paths", () => {
  it("are denied for read and write in the project", () => {
    for (const p of [".env", "sub/.env", ".env.local", "config/prod.env", ".npmrc", "certs/server.pem", "certs/server.key", "id_ed25519"]) {
      for (const access of ["read", "write"] as const) {
        assert.equal(decidePath(`/work/proj/${p}`, access, SHIPPED(), CTX).decision, "deny", `${access} ${p}`);
      }
    }
  });

  it("leave .env.example readable", () => {
    assert.equal(decidePath("/work/proj/.env.example", "read", SHIPPED(), CTX).decision, "allow");
    assert.equal(decidePath("/work/proj/app/.env.example", "read", SHIPPED(), CTX).decision, "allow");
  });

  it("deny the home secrets even inside an extra directory", () => {
    const ctx = { ...CTX, extraDirs: ["/home/u"] };
    for (const p of [".ssh/id_rsa", ".aws/credentials", ".gnupg/pubring.kbx", ".netrc", ".docker/config.json", ".config/gh/hosts.yml"]) {
      const v = decidePath(`/home/u/${p}`, "read", SHIPPED(), ctx);
      assert.equal(v.decision, "deny", p);
      assert.ok((v.reason ?? "").length > 0, p);
    }
  });

  it("are all from the shipped source", () => {
    assert.ok(shippedPathRules().length > 0);
    assert.ok(shippedPathRules().every((r) => r.source === "shipped"));
  });
});

describe("T211: protected paths", () => {
  it("can be read and ask on write, marked protected", () => {
    for (const d of [".git", ".config/git", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn", ".lykos", ".pi", ".github/workflows"]) {
      assert.equal(decidePath(`/work/proj/${d}/x`, "read", SHIPPED(), CTX).decision, "allow", `read ${d}`);
      const w = decidePath(`/work/proj/${d}/x`, "write", SHIPPED(), CTX);
      assert.equal(w.decision, "ask", `write ${d}`);
      assert.equal(w.protected, true, `write ${d}`);
    }
    const home = decidePath("/home/u/.lykos/config.yaml", "write", SHIPPED(), { ...CTX, extraDirs: ["/home/u"] });
    assert.equal(home.decision, "ask");
    assert.equal(home.protected, true);
  });

  it("an allow rule cannot pre-approve a protected write, from either layer", () => {
    for (const layer of ["global", "project"] as const) {
      const rules = collectPathRules({ [layer]: { write: { ".git/**": "allow" } } }, true);
      const w = decidePath("/work/proj/.git/config", "write", rules, CTX);
      assert.equal(w.decision, "ask", layer);
      assert.equal(w.protected, true, layer);
    }
  });

  it("an ordinary write in the project is not protected", () => {
    const w = decidePath("/work/proj/src/a.ts", "write", SHIPPED(), CTX);
    assert.equal(w.decision, "allow");
    assert.notEqual(w.protected, true);
  });
});

describe("T211: removing a shipped default", () => {
  it("works from global config and not from project config", () => {
    const fromGlobal = collectPathRules({ global: { remove: ["*.env"] } }, true);
    assert.equal(decidePath("/work/proj/.env", "read", fromGlobal, CTX).decision, "allow");
    const fromProject = collectPathRules({ project: { remove: ["*.env"] } }, true);
    assert.equal(decidePath("/work/proj/.env", "read", fromProject, CTX).decision, "deny");
  });
});

describe("T211: the container uses the same rules", () => {
  it("shadows the secret patterns and protects the protected dirs of the host rules", () => {
    const plan = containmentPathPlan(SHIPPED());
    for (const p of ["*.env", ".npmrc", "*.pem", "*.key", "id_*"]) assert.ok(plan.secretPatterns.includes(p), p);
    for (const d of [".git", ".lykos", ".pi", ".vscode", ".github/workflows"]) assert.ok(plan.protectedDirs.includes(d), d);
  });

  it("follows a removal and a user addition, from one config", () => {
    const rules = collectPathRules({ global: { remove: ["*.pem"], read: { "secrets.txt": "deny" } } }, true);
    const plan = containmentPathPlan(rules);
    assert.ok(!plan.secretPatterns.includes("*.pem"));
    assert.ok(plan.secretPatterns.includes("secrets.txt"));
    assert.equal(decidePath("/work/proj/secrets.txt", "read", rules, CTX).decision, "deny");
    assert.equal(decidePath("/work/proj/a.pem", "read", rules, CTX).decision, "allow");
  });
});
