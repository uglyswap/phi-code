import type { AgentTool } from "phi-code-agent";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { decide, loadPolicy } from "../permissions/policy.ts";

function deniedResult<TDetails>(text: string): {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails;
	isError: boolean;
} {
	return { content: [{ type: "text", text }], details: undefined as TDetails, isError: true };
}

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: async (toolCallId, params, signal, onUpdate, ctx?: ExtensionContext) => {
			const context = ctx ?? ctxFactory?.();
			// Permission gate: default (no config anywhere) is allow-everything,
			// preserving pre-permissions behavior.
			const policy = loadPolicy(context?.cwd ?? process.cwd());
			if (!policy.legacyAllowAll) {
				const { decision, tier, matchedRule } = decide(policy, definition.name, params, definition.permissionTier);
				if (decision === "deny") {
					const why = matchedRule
						? ` by rule "${matchedRule.tool}${matchedRule.pattern ? ` ${matchedRule.pattern}` : ""}"`
						: "";
					return deniedResult<TDetails>(
						`Permission denied: tool "${definition.name}" (tier: ${tier}) is denied${why}. Adjust permissions.json to allow it.`,
					);
				}
				if (decision === "prompt") {
					if (context?.hasUI) {
						const subject =
							params && typeof params === "object" && typeof (params as any).command === "string"
								? `: ${(params as any).command.slice(0, 120)}`
								: "";
						const choice = await context.ui.select(`Allow ${definition.name} (${tier})${subject}?`, [
							"Allow",
							"Deny",
						]);
						if (choice !== "Allow") {
							return deniedResult<TDetails>(`Permission denied by user: tool "${definition.name}".`);
						}
					} else {
						return deniedResult<TDetails>(
							`Permission required: tool "${definition.name}" (tier: ${tier}) needs approval, but no interactive UI is available. Set it to "allow" in permissions.json or run interactively.`,
						);
					}
				}
			}
			return definition.execute(toolCallId, params, signal, onUpdate, context as ExtensionContext);
		},
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
