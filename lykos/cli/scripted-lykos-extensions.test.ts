// T147 (backlog D25): a Lykos extension declared in `.lykos/config.yaml`
// reaches a real standalone session. Three declared packages: one installed
// and working (its tool is called by the scripted model and its event handler
// fires), one installed and broken at import, one not installed at all. The
// session completes; the missing one is reported at boot and the broken one
// is reported and counted at the end.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setStderrSink } from "../tui/io-mode.js";
import { call, lastToolResult, mounted, reply, runScriptedSession, say, scriptedPiHost } from "./scripted-session.js";

function installPackage(name: string, files: Record<string, string>): void {
  const dir = join(scriptedPiHost(), "npm", "node_modules", name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
}

// Written only against `LykosExtensionApi` — what any author gets.
const WORKING = `export default {
  name: "ignored — the declared name wins",
  register(api) {
    let approvals = 0;
    api.on("approval_decided", () => { approvals += 1; });
    api.registerTool({
      name: "ext_echo",
      description: "Echo the text back.",
      residency: "resident",
      promptPresence: "listed",
      execute: (args) => ({ text: "echo:" + String(args.text) + " approvals-seen:" + approvals }),
    });
    // Default residency: mounted, reached only through the tool_call transport.
    api.registerTool({
      name: "ext_count",
      description: "How many approvals this extension has seen.",
      execute: () => ({ text: "approvals-seen:" + approvals }),
    });
  },
};
`;

describe("T147 a Lykos extension declared in config.yaml, in a real session", () => {
  it("loads the installed one, reports the missing one, counts the broken one, and the session completes", async () => {
    installPackage("demo-lykos-ext", {
      "package.json": JSON.stringify({ name: "demo-lykos-ext", version: "1.0.0", lykos: { extensions: ["./main.js"] } }),
      "main.js": WORKING,
    });
    installPackage("broken-lykos-ext", { "index.js": `throw new Error("broken on purpose");\n` });

    let stderr = "";
    const restore = setStderrSink((text) => {
      stderr += text;
    });
    let run;
    try {
      run = await runScriptedSession({
        config: [
          "lykos_extensions:",
          "  - name: demo-lykos-ext",
          "    version: 1.0.0",
          "  - name: broken-lykos-ext",
          "    version: 0.1.0",
          "  - name: absent-lykos-ext",
          "    version: 2.0.0",
          "",
        ].join("\n"),
        prompt: "Echo hi through the extension tool.",
        script: [
          (context) => {
            assert.ok(
              context.tools?.some((t) => t.name === "ext_echo"),
              "the declared extension's resident tool is on the wire",
            );
            assert.ok(!context.tools?.some((t) => t.name === "ext_count"), "a mounted one is not");
            return reply(call("ext_echo", { text: "hi" }));
          },
          (context) => {
            const result = lastToolResult(context);
            assert.equal(result.isError, false, result.text);
            // The call went through the gate (auto-approved), which fired the
            // extension's own event handler before the tool ran.
            assert.equal(result.text, "echo:hi approvals-seen:1");
            return reply(mounted("ext_count", {}));
          },
          (context) => {
            const result = lastToolResult(context);
            assert.equal(result.isError, false, result.text);
            assert.match(result.text, /^approvals-seen:[1-9]/);
            return reply(say("done"));
          },
        ],
      });
    } finally {
      restore();
    }

    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.match(stderr, /lykos extensions loaded: demo-lykos-ext@1\.0\.0, broken-lykos-ext@0\.1\.0/);
    assert.match(stderr, /lykos extensions DECLARED BUT NOT INSTALLED on this host: absent-lykos-ext@2\.0\.0/);
    assert.match(stderr, /1 extension failure\(s\) this session — broken-lykos-ext \(1\)/);
    assert.match(stderr, /broken-lykos-ext on load: .*broken on purpose/);
    assert.match(run.show(), /tool_result\s+ext_echo\s+state=ok/);
  });
});
