import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOOL_REGISTRY, type ToolRegistryEntry } from "../tools/tool-surface.js";
import {
  FULL_PRESENCE_SAVES_NOTHING,
  MOUNTED_CATALOG_HEADING,
  assembleMountedCatalogHead,
} from "./mounted-catalog-head.js";

function entry(
  name: string,
  residency: ToolRegistryEntry["residency"],
  promptPresence: ToolRegistryEntry["promptPresence"],
): ToolRegistryEntry {
  return {
    name,
    residency,
    promptPresence,
    rationale: `${name} rationale.`,
    risk: { tier: "read", idempotent: true, openWorld: false },
  };
}

describe("assembleMountedCatalogHead", () => {
  it("renders a named mounted tool as one line and omits hidden tools", () => {
    const text = assembleMountedCatalogHead([
      entry("find", "mounted", "hidden"),
      entry("agent", "mounted", "named"),
      entry("read", "resident", "full"),
    ]);
    assert.ok(text.startsWith(MOUNTED_CATALOG_HEADING));
    assert.match(text, /^- agent: /m);
    assert.equal(text.includes("find"), false);
    assert.equal(text.includes("read rationale"), false);
    assert.equal(text.includes(FULL_PRESENCE_SAVES_NOTHING), false);
  });

  it("inlines a full mounted tool's docs and states that full saves no tokens", () => {
    const text = assembleMountedCatalogHead([entry("eval", "mounted", "full")]);
    assert.ok(text.includes(FULL_PRESENCE_SAVES_NOTHING));
    assert.ok(text.includes("### eval"));
    assert.ok(text.includes("parameters:"));
  });

  it("appends nothing when the catalog has no named or full mounted tools", () => {
    assert.equal(assembleMountedCatalogHead([entry("find", "mounted", "hidden")]), "");
    assert.equal(assembleMountedCatalogHead([]), "");
  });

  it("is byte-identical across two assemblies of the live registry", () => {
    assert.equal(assembleMountedCatalogHead(), assembleMountedCatalogHead(TOOL_REGISTRY));
  });

  it("does not name hidden mounted tools from the live registry", () => {
    const text = assembleMountedCatalogHead();
    assert.ok(text.includes("- agent:"));
    assert.equal(text.includes("- find:"), false);
    assert.equal(text.includes("- ls:"), false);
  });
});
