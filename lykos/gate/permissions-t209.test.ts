// T209 acceptance (sealed): the permission mode is remembered per project, Manual on first run (ADR-0041).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPermissions, rememberAllow, rememberMode, startingMode } from "./permissions.js";
import { runPermissionsCommand } from "./permissions-command.js";

const store = () => ({ permissionsPath: join(mkdtempSync(join(tmpdir(), "lykos-t209-")), "permissions.json") });

describe("T209: the starting mode", () => {
  it("is Manual for a project with no entry", () => {
    assert.equal(startingMode("never-seen", store()), "manual");
  });

  it("is the last mode used in that project, and only that project", () => {
    const opts = store();
    rememberMode("proj-a", "auto", opts);
    assert.equal(startingMode("proj-a", opts), "auto");
    assert.equal(startingMode("proj-b", opts), "manual");
  });
});

describe("T209: /permissions", () => {
  it("bare shows the mode, the outside rules, the extra directories and the approvals", () => {
    const opts = store();
    rememberMode("p", "accept-edits", opts);
    rememberAllow("p", ["npm test"], opts);
    const out = runPermissionsCommand("", { projectId: "p", opts });
    assert.ok(out.ok);
    assert.match(out.report, /Accept Edits|accept-edits/);
    assert.match(out.report, /outside/i);
    assert.match(out.report, /npm test/);
  });

  it("sets the mode and remembers it", () => {
    const opts = store();
    const out = runPermissionsCommand("mode auto", { projectId: "p", opts });
    assert.ok(out.ok);
    assert.equal(out.mode, "auto");
    assert.equal(startingMode("p", opts), "auto");
  });

  it("rejects plan as a mode, naming read_only", () => {
    const out = runPermissionsCommand("mode plan", { projectId: "p", opts: store() });
    assert.equal(out.ok, false);
    assert.match(out.report, /read_only/);
  });

  it("sets an outside rule and remembers it", () => {
    const opts = store();
    assert.ok(runPermissionsCommand("outside read allow", { projectId: "p", opts }).ok);
    assert.equal(loadPermissions("p", opts).outside.read, "allow");
    assert.equal(loadPermissions("p", opts).outside.write, "ask");
  });

  it("adds and removes an extra directory, remembered", () => {
    const opts = store();
    assert.ok(runPermissionsCommand("dir add /data/shared", { projectId: "p", opts }).ok);
    assert.deepEqual(loadPermissions("p", opts).extraDirs, ["/data/shared"]);
    assert.ok(runPermissionsCommand("dir remove /data/shared", { projectId: "p", opts }).ok);
    assert.deepEqual(loadPermissions("p", opts).extraDirs, []);
  });

  it("revokes a remembered approval", () => {
    const opts = store();
    rememberAllow("p", ["npm test", "tsc"], opts);
    assert.ok(runPermissionsCommand("revoke npm test", { projectId: "p", opts }).ok);
    assert.deepEqual([...loadPermissions("p", opts).allow], ["tsc"]);
  });

  it("an unknown subcommand fails with usage", () => {
    const out = runPermissionsCommand("frobnicate", { projectId: "p", opts: store() });
    assert.equal(out.ok, false);
    assert.match(out.report, /mode|outside|dir|revoke/);
  });
});
