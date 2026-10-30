import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPermissions } from "./permissions.js";
import { runPermissionsCommand } from "./permissions-command.js";

const store = () => ({ permissionsPath: join(mkdtempSync(join(tmpdir(), "lykos-permcmd-")), "permissions.json") });

describe("/permissions dir", () => {
  it("stores a relative directory as the absolute path it names, since path rules compare absolute paths", () => {
    const opts = store();
    const cwd = mkdtempSync(join(tmpdir(), "lykos-permcmd-cwd-"));
    assert.equal(runPermissionsCommand("dir add ../shared", { projectId: "p", opts, cwd }).ok, true);
    assert.deepEqual(loadPermissions("p", opts).extraDirs, [resolve(cwd, "../shared")]);
    runPermissionsCommand("dir remove ../shared", { projectId: "p", opts, cwd });
    assert.deepEqual(loadPermissions("p", opts).extraDirs, []);
  });

  it("T212: bare prints path rules enforcement status according to containment", () => {
    const opts = store();
    const hostRes = runPermissionsCommand("", { projectId: "p", opts });
    assert.ok(hostRes.ok);
    assert.match(hostRes.report, /path rules: enforced for file tools; commands best effort/);

    const contRes = runPermissionsCommand("", { projectId: "p", opts, contained: true });
    assert.ok(contRes.ok);
    assert.match(contRes.report, /path rules: enforced for file tools; commands enforced/);
  });
});
