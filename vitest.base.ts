import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	schemaIndex: fileURLToPath(new URL("./packages/schema/src/index.ts", import.meta.url)),
	mcpIndex: fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
	mcpOAuth: fileURLToPath(new URL("./packages/mcp/src/oauth/index.ts", import.meta.url)),
	mcpTesting: fileURLToPath(new URL("./packages/mcp/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiModels: fileURLToPath(new URL("./packages/ai/src/models.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codemodeIndex: fileURLToPath(new URL("./packages/codemode/src/index.ts", import.meta.url)),
	codemodeDeclarations: fileURLToPath(new URL("./packages/codemode/src/declarations.ts", import.meta.url)),
	codemodeSource: fileURLToPath(new URL("./packages/codemode/src/source.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@lykos\/telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@lykos\/telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@lykos\/schema$/, replacement: workspaceSourcePaths.schemaIndex },
			{ find: /^@lykos\/mcp$/, replacement: workspaceSourcePaths.mcpIndex },
			{ find: /^@lykos\/mcp\/oauth$/, replacement: workspaceSourcePaths.mcpOAuth },
			{ find: /^@lykos\/mcp\/testing$/, replacement: workspaceSourcePaths.mcpTesting },
			{ find: /^@lykos\/ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@lykos\/ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@lykos\/ai\/models$/, replacement: workspaceSourcePaths.aiModels },
			{ find: /^@lykos\/ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@lykos\/ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{
				find: /^@lykos\/ai\/api\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiApi}/$1.ts`,
			},
			{
				find: /^@lykos\/ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@lykos\/agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@lykos\/codemode$/, replacement: workspaceSourcePaths.codemodeIndex },
			{ find: /^@lykos\/codemode\/declarations$/, replacement: workspaceSourcePaths.codemodeDeclarations },
			{ find: /^@lykos\/codemode\/source$/, replacement: workspaceSourcePaths.codemodeSource },
			{ find: /^@lykos\/tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
