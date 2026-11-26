export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.LYKOS_EXPERIMENTAL === "1";
}
