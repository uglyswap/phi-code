/**
 * API key protecting the vLLM endpoints. `PHI_API_KEY` is the documented name;
 * `PI_API_KEY` is still honoured for existing setups. Every command must read it
 * through this helper: `setup`/`start` used to read only `PI_API_KEY` while
 * `agent` read `PHI_API_KEY` first, so a `PHI_API_KEY`-only setup failed and
 * `start` shipped the literal string "undefined" to the pod as the key.
 */
export const getVllmApiKey = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
	const key = env.PHI_API_KEY || env.PI_API_KEY;
	return key?.trim() ? key : undefined;
};
