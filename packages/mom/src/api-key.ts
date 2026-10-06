/** Minimal view of `ModelRuntime` needed to resolve a provider credential. */
export interface ProviderAuthSource {
	getAuth(providerId: string): Promise<{ auth: { apiKey?: string } } | undefined>;
}

/**
 * Resolve the API key for the provider of the model being called.
 *
 * The agent loop passes `model.provider` to `getApiKey`; resolving a fixed
 * provider instead would send that provider's key to whatever endpoint
 * MOM_MODEL points at (or fail for every non-default provider).
 */
export async function resolveProviderApiKey(
	source: ProviderAuthSource,
	provider: string,
	authPath: string,
): Promise<string> {
	const auth = await source.getAuth(provider);
	const key = auth?.auth.apiKey;
	if (!key) {
		throw new Error(
			`No API key found for ${provider}.\n\n` +
				`Set the API key environment variable for ${provider}, or use /login and link auth.json to ${authPath}`,
		);
	}
	return key;
}
