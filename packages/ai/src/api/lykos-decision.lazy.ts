import type { ProviderClassifier } from "../types.ts";

export const piDecisionApi = (): ProviderClassifier => ({
	classify: async (model, context, options) => (await import("./lykos-decision.ts")).classify(model, context, options),
});
