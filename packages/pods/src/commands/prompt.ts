import chalk from "chalk";
import { AGENT_COMMAND, CLI_COMMAND } from "../branding.ts";
import { getActivePod, loadConfig } from "../config.ts";

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

interface PromptOptions {
	pod?: string;
	apiKey?: string;
}

// ────────────────────────────────────────────────────────────────────────────────
// Main prompt function
// ────────────────────────────────────────────────────────────────────────────────

export async function promptModel(modelName: string, userArgs: string[], opts: PromptOptions = {}) {
	// Get pod and model configuration
	const activePod = opts.pod ? { name: opts.pod, pod: loadConfig().pods[opts.pod] } : getActivePod();

	if (!activePod) {
		console.error(chalk.red(`No active pod. Use '${CLI_COMMAND} pods active <name>' to set one.`));
		process.exit(1);
	}

	const { name: podName, pod } = activePod;
	const modelConfig = pod.models[modelName];

	if (!modelConfig) {
		console.error(chalk.red(`Model '${modelName}' not found on pod '${podName}'`));
		process.exit(1);
	}

	// Extract host from SSH string
	const host =
		pod.ssh
			.split(" ")
			.find((p) => p.includes("@"))
			?.split("@")[1] ?? "localhost";

	// Build the system prompt for code navigation
	const systemPrompt = `You help the user understand and navigate the codebase in the current working directory.

You can read files, list directories, and execute shell commands via the respective tools.

Do not output file contents you read via the read_file tool directly, unless asked to.

Do not output markdown tables as part of your responses.

Keep your responses concise and relevant to the user's request.

File paths you output must include line numbers where possible, e.g. "src/index.ts:10-20" for lines 10 to 20 in src/index.ts.

Current working directory: ${process.cwd()}`;

	const baseUrl = `http://${host}:${modelConfig.port}/v1`;
	const api = modelConfig.model.toLowerCase().includes("gpt-oss") ? "openai-responses" : "openai-completions";
	const apiKey = opts.apiKey || process.env.PHI_API_KEY || process.env.PI_API_KEY || "dummy";

	// This command is NOT wired to the agent.
	//
	// It used to hand `--base-url` / `--api` to the agent CLI, which stopped accepting
	// them: an endpoint is described by a provider entry in models.json now. Rather
	// than report "Agent error: Not implemented" — which reads as a failure of the
	// remote model — say what is missing and hand over the exact working recipe.
	console.error(chalk.red(`'prompt' is not wired to the ${AGENT_COMMAND} agent in this build.`));
	console.error("");
	console.error(`The pod's endpoint is reachable at ${chalk.cyan(baseUrl)} (model ${chalk.cyan(modelConfig.model)}).`);
	console.error("Declare it once as a provider in ~/.phi/agent/models.json:");
	console.error("");
	console.error(
		chalk.dim(
			JSON.stringify(
				{
					providers: {
						[`pod-${podName}`]: {
							name: `Pod ${podName}`,
							baseUrl,
							api,
							apiKey,
							models: [{ id: modelConfig.model }],
						},
					},
				},
				null,
				2,
			),
		),
	);
	console.error("");
	console.error(`Then run: ${chalk.cyan(`${AGENT_COMMAND} --model pod-${podName}/${modelConfig.model}`)}`);
	if (userArgs.length > 0) {
		console.error(chalk.dim(`(your arguments: ${userArgs.join(" ")})`));
	}
	console.error("");
	console.error(chalk.dim(`System prompt this command would have used:\n${systemPrompt}`));
	process.exit(1);
}
