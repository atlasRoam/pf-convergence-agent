export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.AGENTCORE_EXPERIMENTAL === "1";
}
