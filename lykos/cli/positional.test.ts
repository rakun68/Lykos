import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { firstPositional } from "./args.js";

const VALUED = ["model", "tools", "budget", "shape", "task"] as const;

describe("T90 firstPositional", () => {
  it("finds the prompt when it comes first, the way it always worked", () => {
    assert.equal(firstPositional(["do the thing", "--yes"], VALUED), "do the thing");
  });

  it("finds the prompt when flags come first -- the defect the sweep found", () => {
    assert.equal(
      firstPositional(["--shape", "standalone", "--yes", "do the thing"], VALUED),
      "do the thing",
      "a flag name must never be sent to the model as the task",
    );
  });

  it("does not mistake a valued flag's value for the prompt", () => {
    assert.equal(firstPositional(["--model", "deepseek/v4", "the task"], VALUED), "the task");
    assert.equal(firstPositional(["--tools", "read,bash", "the task"], VALUED), "the task");
  });

  it("handles --name=value, which consumes nothing after it", () => {
    assert.equal(firstPositional(["--model=deepseek/v4", "the task"], VALUED), "the task");
  });

  it("does not skip an argument after a boolean flag", () => {
    assert.equal(firstPositional(["--yes", "the task"], VALUED), "the task");
  });

  it("respects -- as an explicit end of flags, so a prompt may start with dashes", () => {
    assert.equal(firstPositional(["--yes", "--", "--shape is what I want to discuss"], VALUED), "--shape is what I want to discuss");
  });

  it("returns undefined when there is no prompt at all", () => {
    assert.equal(firstPositional(["--yes", "--shape", "standalone"], VALUED), undefined);
  });

  it("returns undefined for an empty argument list", () => {
    assert.equal(firstPositional([], VALUED), undefined);
  });
});
