// Which image a session's commands run in.
//
// The seam is `startContainment` and a scripted session, with the stand-in
// runtime recording what it was asked to build and start. Order under test:
// the specialist's image, project config's, the devcontainer's, the default.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../config/load.js";
import { ContainmentError, defaultImageTag, startContainment } from "../containment/containment.js";
import { standInRuntime, type StandInRuntime } from "./scripted-container.js";
import { call, reply, runScriptedSession, say } from "./scripted-session.js";

function workspaceWith(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lykos-devcontainer-")));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const DEVCONTAINER = ".devcontainer/devcontainer.json";
const start = (runtime: StandInRuntime, workspace: string, config: { image?: string; network?: "open" | "none" } = {}) =>
  startContainment({ config: { level: "required", ...config }, workspace, drivers: [runtime.driver] });
const builds = (runtime: StandInRuntime) => runtime.operations.filter((o) => o.op === "build");
const started = (runtime: StandInRuntime) => {
  const op = runtime.operations.find((o) => o.op === "start");
  assert.ok(op?.op === "start");
  return op.spec;
};

describe("the image comes from the devcontainer (T177)", () => {
  it("a devcontainer that names an image runs commands in that image, and builds nothing", async () => {
    const runtime = standInRuntime();
    const c = await start(runtime, workspaceWith({ [DEVCONTAINER]: '{ "image": "mcr.microsoft.com/devcontainers/python:3.12" }' }));
    assert.equal(started(runtime).image, "mcr.microsoft.com/devcontainers/python:3.12");
    assert.equal(c.record.image, "mcr.microsoft.com/devcontainers/python:3.12");
    assert.deepEqual(builds(runtime), []);
    await c.dispose();
  });

  it("comments and trailing commas in devcontainer.json parse, and text that looks like either inside a string survives", async () => {
    const runtime = standInRuntime();
    const text = `// the toolchain
{
  /* block
     comment */
  "name": "a // b /* c */",
  "image": "example.com/dev:1", // trailing comma follows
  "features": { "x": {}, },
}
`;
    const c = await start(runtime, workspaceWith({ [DEVCONTAINER]: text }));
    assert.equal(c.record.image, "example.com/dev:1");
    await c.dispose();
  });

  it("a build.dockerfile is built through the runtime on every start; its tag is stable until the Dockerfile or context changes", async () => {
    const runtime = standInRuntime();
    const ws = workspaceWith({
      [DEVCONTAINER]: '{ "build": { "dockerfile": "Dockerfile" } }',
      ".devcontainer/Dockerfile": "FROM scratch\n# one\n",
    });

    const first = await start(runtime, ws);
    assert.match(first.record.image ?? "", /^lykos\/devcontainer:[0-9a-f]{12}$/);
    assert.equal(builds(runtime).length, 1);
    const [build] = builds(runtime);
    assert.ok(build?.op === "build");
    assert.equal(build.dockerfile, join(ws, ".devcontainer", "Dockerfile"));
    assert.equal(build.context, join(ws, ".devcontainer"), "the context defaults to the devcontainer's own directory");
    assert.equal(started(runtime).image, first.record.image);
    await first.dispose();

    const second = await start(runtime, ws);
    // Built again on purpose: the runtime's layer cache decides what changed, which also catches an edited file the Dockerfile COPYs.
    assert.equal(builds(runtime).length, 2, "the runtime is asked each start");
    assert.equal(second.record.image, first.record.image, "same inputs, same tag");
    await second.dispose();

    writeFileSync(join(ws, ".devcontainer", "Dockerfile"), "FROM scratch\n# two\n");
    const third = await start(runtime, ws);
    assert.equal(builds(runtime).length, 3);
    assert.notEqual(third.record.image, first.record.image);
    await third.dispose();
  });

  it("build.context is relative to the devcontainer directory", async () => {
    const runtime = standInRuntime();
    const ws = workspaceWith({
      [DEVCONTAINER]: '{ "build": { "dockerfile": "Dockerfile", "context": ".." } }',
      ".devcontainer/Dockerfile": "FROM scratch\n",
    });
    await (await start(runtime, ws)).dispose();
    const [build] = builds(runtime);
    assert.ok(build?.op === "build");
    assert.equal(build.context, ws);
  });

  it("the same Dockerfile built against a different context is a different image", async () => {
    const runtime = standInRuntime();
    const files = (context: string) => ({
      [DEVCONTAINER]: `{ "build": { "dockerfile": "Dockerfile", "context": "${context}" } }`,
      ".devcontainer/Dockerfile": "FROM scratch\n",
      "sub/.keep": "",
    });
    const a = await start(runtime, workspaceWith(files(".")));
    const b = await start(runtime, workspaceWith(files("../sub")));
    assert.notEqual(a.record.image, b.record.image);
    await a.dispose();
    await b.dispose();
  });

  it("without a devcontainer, or one that names no image or build, the default image runs", async () => {
    for (const files of [{}, { [DEVCONTAINER]: '{ "name": "only features", "features": {} }' }]) {
      const runtime = standInRuntime();
      const c = await start(runtime, workspaceWith(files));
      assert.equal(c.record.image, defaultImageTag());
      await c.dispose();
    }
  });

  it("project config's containment.image overrides the devcontainer", async () => {
    const runtime = standInRuntime();
    const ws = workspaceWith({
      [DEVCONTAINER]: '{ "build": { "dockerfile": "Dockerfile" } }',
      ".devcontainer/Dockerfile": "FROM scratch\n",
    });
    const c = await start(runtime, ws, { image: "example.com/configured:2" });
    assert.equal(c.record.image, "example.com/configured:2");
    assert.deepEqual(builds(runtime), [], "the devcontainer's Dockerfile is not built when config names the image");
    await c.dispose();
  });

  it("refuses a Dockerfile or context outside the workspace, naming it", async () => {
    for (const build of ['{ "dockerfile": "../../outside/Dockerfile" }', '{ "dockerfile": "Dockerfile", "context": "../.." }']) {
      const ws = workspaceWith({ [DEVCONTAINER]: `{ "build": ${build} }`, ".devcontainer/Dockerfile": "FROM scratch\n" });
      const runtime = standInRuntime();
      await assert.rejects(start(runtime, ws), (err: unknown) => {
        assert.ok(err instanceof ContainmentError);
        assert.match((err as Error).message, /outside the workspace/);
        return true;
      });
      assert.deepEqual(builds(runtime), []);
    }
  });

  it("a devcontainer.json that is not JSON stops the session, naming the file", async () => {
    const runtime = standInRuntime();
    await assert.rejects(start(runtime, workspaceWith({ [DEVCONTAINER]: "{ image: nope" })), (err: unknown) => {
      assert.ok(err instanceof ContainmentError);
      assert.match((err as Error).message, /devcontainer\.json/);
      return true;
    });
    assert.deepEqual(
      runtime.operations.filter((o) => o.op === "start"),
      [],
    );
  });

  it("level off never reads the devcontainer", async () => {
    const runtime = standInRuntime();
    const c = await startContainment({ config: { level: "off" }, workspace: workspaceWith({ [DEVCONTAINER]: "{ not json" }), drivers: [runtime.driver] });
    assert.equal(c.record.used, "off");
  });
});

describe("a global image ranks below the project's devcontainer (T177)", () => {
  const globalConfig = (image: string) => {
    const globalDir = mkdtempSync(join(tmpdir(), "lykos-global-"));
    writeFileSync(join(globalDir, "config.yaml"), `containment:
  image: ${image}
`);
    return globalDir;
  };
  const containmentOf = (workspace: string, globalDir: string) => loadConfig({ cwd: workspace, globalDir, env: {} }).resolved.containment;

  it("loses to a devcontainer and beats the shipped default", async () => {
    const globalDir = globalConfig("example.com/global:1");

    const withDevcontainer = workspaceWith({ [DEVCONTAINER]: '{ "image": "example.com/devcontainer:1" }' });
    const a = await startContainment({ config: { ...containmentOf(withDevcontainer, globalDir), level: "required" }, workspace: withDevcontainer, drivers: [standInRuntime().driver] });
    assert.equal(a.record.image, "example.com/devcontainer:1");

    const bare = workspaceWith({});
    const b = await startContainment({ config: { ...containmentOf(bare, globalDir), level: "required" }, workspace: bare, drivers: [standInRuntime().driver] });
    assert.equal(b.record.image, "example.com/global:1");
  });

  it("a project's containment.image beats the devcontainer and the global image", async () => {
    const globalDir = globalConfig("example.com/global:1");
    const ws = workspaceWith({
      [DEVCONTAINER]: '{ "image": "example.com/devcontainer:1" }',
      ".lykos/config.yaml": "containment:\n  image: example.com/project:1\n",
    });
    const c = await startContainment({ config: { ...containmentOf(ws, globalDir), level: "required" }, workspace: ws, drivers: [standInRuntime().driver] });
    assert.equal(c.record.image, "example.com/project:1");
  });
});

describe("a specialist's containment reaches the session (T177, ADR-0037)", () => {
  const specialist = (yaml: string) => ({ ".lykos/specialists/boxed.yaml": yaml });
  const QUIET = "feedback:\n  enabled: false\ngate:\n  enabled: false\n";

  it("its image and network are what the container is started with, and the ledger records the image", async () => {
    const runtime = standInRuntime();
    const s = await runScriptedSession({
      files: {
        ...specialist("containment:\n  image: example.com/specialist:3\n  network: none\n"),
        [DEVCONTAINER]: '{ "image": "example.com/devcontainer:1" }',
      },
      config: `${QUIET}containment:\n  level: required\n  image: example.com/project:2\n`,
      extra: { specialist: "boxed", containmentDrivers: [runtime.driver] },
      script: [reply(call("bash", { command: "true" })), reply(say("done"))],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    assert.equal(started(runtime).image, "example.com/specialist:3", "the specialist overrides project config and the devcontainer");
    assert.equal(started(runtime).network, "none");
    assert.equal(s.session().container_image, "example.com/specialist:3");
    assert.equal(s.session().container_network, "none");
  });

  it("its level applies where the specialist is chosen, over project config", async () => {
    const runtime = standInRuntime({ available: false });
    const s = await runScriptedSession({
      files: specialist("containment:\n  level: required\n"),
      config: `${QUIET}containment:\n  level: off\n`,
      extra: { specialist: "boxed", containmentDrivers: [runtime.driver] },
      script: [reply(say("never reached"))],
    });
    assert.equal(s.result.status, "error", "required, and no runtime answers");
    assert.match(JSON.stringify(s.result), /containment\.level is \\"required\\"/);
  });

  it("a specialist with no opinion leaves the devcontainer in charge", async () => {
    const runtime = standInRuntime();
    const s = await runScriptedSession({
      files: { ...specialist("description: no containment\n"), [DEVCONTAINER]: '{ "image": "example.com/devcontainer:1" }' },
      config: `${QUIET}containment:\n  level: required\n`,
      extra: { specialist: "boxed", containmentDrivers: [runtime.driver] },
      script: [reply(call("bash", { command: "true" })), reply(say("done"))],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    assert.equal(s.session().container_image, "example.com/devcontainer:1");
  });
});
