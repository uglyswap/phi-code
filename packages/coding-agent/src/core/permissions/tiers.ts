/**
 * Permission tiers for tools. Inspired by oh-my-pi's approval tiers.
 *
 * Every tool invocation is classified read/write/exec. The policy engine
 * (policy.ts) maps tiers and pattern rules to allow/deny/prompt decisions.
 */

export type PermissionTier = "read" | "write" | "exec";

/** Core tool tiers. Extension tools declare theirs via the optional
 * `permissionTier` field on the tool definition; absent -> "exec" for bash-like
 * names is not guessable, so unknown tools default to "write" (middle tier). */
const CORE_TOOL_TIERS: Record<string, PermissionTier> = {
	read: "read",
	grep: "read",
	find: "read",
	ls: "read",
	ast_grep: "read",
	lsp: "read",
	memory_search: "read",
	memory_read: "read",
	memory_status: "read",
	ontology_query: "read",
	write: "write",
	edit: "write",
	memory_write: "write",
	ontology_add: "write",
	ontology_batch_add: "write",
	bash: "exec",
	eval: "exec",
};

export function tierForTool(toolName: string, declaredTier?: PermissionTier): PermissionTier {
	if (declaredTier) return declaredTier;
	const core = CORE_TOOL_TIERS[toolName];
	if (core) return core;
	// Unknown/extension tools: middle tier, prompt by default policy.
	return "write";
}
