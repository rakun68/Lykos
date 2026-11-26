import * as bundledPiAgentCore from "@lykos/agent-core";
import * as bundledPiAiModels from "@lykos/ai/models";
import * as bundledPiAiOauth from "@lykos/ai/oauth";
import * as bundledPiAiProviders from "@lykos/ai/providers/all";
import * as bundledPiTui from "@lykos/tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @lykos/coding-agent.
import * as bundledPiCodingAgent from "../../index.ts";
import * as bundledPiAiExtensionView from "./lykos-ai-extension-view.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@lykos/agent-core": bundledPiAgentCore,
	"@lykos/tui": bundledPiTui,
	// Extensions resolve the lykos-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint) plus TypeBox's Type, Static and TSchema:
	// existing extensions using the old global API and lykos-ai's former TypeBox
	// re-exports keep working.
	"@lykos/ai": bundledPiAiExtensionView,
	"@lykos/ai/compat": bundledPiAiExtensionView,
	"@lykos/ai/models": bundledPiAiModels,
	"@lykos/ai/oauth": bundledPiAiOauth,
	"@lykos/ai/providers/all": bundledPiAiProviders,
	"@lykos/coding-agent": bundledPiCodingAgent,
};
