/**
 * Who may trigger mom. Every trigger runs an agent with bash access, so the
 * default is closed: mom refuses to start until MOM_ALLOWED_USERS is set.
 *
 * - `MOM_ALLOWED_USERS=U012ABC,U034DEF` : only these Slack user IDs
 * - `MOM_ALLOWED_USERS=*`               : anyone who can mention or DM the bot
 *                                         (explicit opt-in to the old behaviour)
 */
export type AccessPolicy = { mode: "everyone" } | { mode: "allowlist"; userIds: ReadonlySet<string> };

/** Slack user IDs: an uppercase letter prefix (U, W) followed by uppercase alphanumerics. */
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

export const ALLOWED_USERS_ENV = "MOM_ALLOWED_USERS";

/**
 * Parse the MOM_ALLOWED_USERS value. Returns an error message instead of a
 * policy when the value is missing or contains something that is not a Slack
 * user ID (a typo must not silently lock everyone out or let everyone in).
 */
export function parseAccessPolicy(value: string | undefined): AccessPolicy | { error: string } {
	const raw = value?.trim() ?? "";
	if (raw === "") {
		return {
			error:
				`Missing env: ${ALLOWED_USERS_ENV}. Set it to a comma-separated list of Slack user IDs ` +
				`allowed to use mom (e.g. ${ALLOWED_USERS_ENV}=U012ABC,U034DEF), or to "*" to allow everyone ` +
				"who can mention or DM the bot.",
		};
	}
	if (raw === "*") return { mode: "everyone" };

	const userIds = new Set<string>();
	for (const entry of raw.split(",")) {
		const id = entry.trim();
		if (id === "") continue;
		if (!SLACK_USER_ID.test(id)) {
			return {
				error: `Invalid ${ALLOWED_USERS_ENV} entry "${id}": expected a Slack user ID such as U012ABC (not a user name).`,
			};
		}
		userIds.add(id);
	}
	if (userIds.size === 0) {
		return { error: `${ALLOWED_USERS_ENV} does not contain any Slack user ID.` };
	}
	return { mode: "allowlist", userIds };
}

export function isUserAllowed(policy: AccessPolicy, userId: string): boolean {
	return policy.mode === "everyone" || policy.userIds.has(userId);
}
