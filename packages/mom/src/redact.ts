// Scrub common secret shapes before posting anything produced by an agent run
// (tool args/results, tool errors, model text) to Slack. Slack message history
// is outside the operator's control, so a model that reads .env / dumps env vars
// must not leak raw secrets into it.
//
// Character classes include "-" and "_" because modern keys embed them
// (sk-ant-api03-..., sk-proj-..., github_pat_..., xoxb-...): a class without
// them stops at the first separator and leaves the secret body in clear.
const SECRET_PATTERNS: RegExp[] = [
	/sk-[A-Za-z0-9_-]{16,}/g, // OpenAI (sk-, sk-proj-) and Anthropic (sk-ant-) keys
	/github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained personal access tokens
	/gh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub classic tokens (ghp_, gho_, ghu_, ghs_, ghr_)
	/xox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack bot/user/legacy tokens (xoxb-, xoxp-, ...)
	/xapp-[A-Za-z0-9-]{10,}/g, // Slack app-level tokens
	/AIza[0-9A-Za-z_-]{30,}/g, // Google API keys
	/AKIA[0-9A-Z]{16}/g, // AWS access key IDs
	/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, // Bearer tokens
	/eyJ[A-Za-z0-9._-]{16,}/g, // JWTs
];

export function redactSecrets(text: string): string {
	let scrubbed = text;
	for (const pattern of SECRET_PATTERNS) {
		scrubbed = scrubbed.replace(pattern, "[REDACTED]");
	}
	return scrubbed;
}
