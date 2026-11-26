import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: { LYKOS_OFFLINE: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{ find: /^@lykos\/ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@lykos\/agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@lykos\/ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@lykos\/ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@lykos\/agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@lykos\/tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
