import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^phi-code-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^phi-code-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^phi-code-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^phi-code-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^phi-code-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^phi-code-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^phi-code-agent$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^phi-code-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
