import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import chalk from "chalk";
import { ensurePodProvider, podProviderId } from "../agent-provider.ts";
import { AGENT_COMMAND, AGENT_PACKAGE, CLI_COMMAND } from "../branding.ts";
import { getActivePod, loadConfig } from "../config.ts";

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

interface PromptOptions {
	pod?: string;
	apiKey?: string;
}

// ────────────────────────────────────────────────────────────────────────────────
// Agent lookup
// ────────────────────────────────────────────────────────────────────────────────

/** How to start the agent: an executable plus the arguments that must precede ours. */
interface AgentLaunch {
	command: string;
	prefixArgs: string[];
}

/**
 * Find the JavaScript entry point a Windows shim delegates to.
 *
 * Node refuses to spawn a .cmd/.bat file unless `shell: true` (the fix for
 * CVE-2024-27980 turned it into EINVAL), and a shell is not an option here: the
 * system prompt below is multi-line, and cmd.exe cannot carry a newline inside an
 * argument. Running the target script under the current node binary sidesteps
 * both problems — no shell parses our arguments, so nothing needs quoting.
 *
 * The canonical npm layout puts the package next to the shim; the shim text is
 * read as a fallback because pnpm and yarn lay theirs out differently but every
 * variant still names the .js file it runs.
 */
function resolveShimTarget(shimPath: string, shimDir: string): string | null {
	const manifestPath = join(shimDir, "node_modules", ...AGENT_PACKAGE.split("/"), "package.json");
	if (existsSync(manifestPath)) {
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
				bin?: string | Record<string, string>;
			};
			const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[AGENT_COMMAND];
			if (entry) {
				const target = join(shimDir, "node_modules", ...AGENT_PACKAGE.split("/"), entry);
				if (existsSync(target)) return target;
			}
		} catch {
			// A malformed manifest is not fatal: fall through to reading the shim.
		}
	}

	try {
		const shim = readFileSync(shimPath, "utf-8");
		for (const match of shim.matchAll(/["']?([^"'\s]+\.[cm]?js)["']?/g)) {
			const raw = match[1].replace(/%~?dp0%?\\?/gi, "").replace(/\$basedir\//g, "");
			const target = isAbsolute(raw) ? raw : resolve(shimDir, raw);
			if (existsSync(target)) return target;
		}
	} catch {
		// Unreadable shim: reported by the caller as "agent not found".
	}
	return null;
}

/**
 * Find the coding agent on PATH.
 *
 * pods is published on its own and does not depend on the agent package, so the
 * binary is resolved at call time instead of imported.
 */
function resolveAgentLaunch(): AgentLaunch | null {
	// No bare name on Windows: npm also drops an extensionless shell script there,
	// which is a bash script the OS cannot execute.
	const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
	for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
		for (const ext of extensions) {
			const candidate = join(dir, `${AGENT_COMMAND}${ext}`);
			if (!existsSync(candidate)) continue;
			if (ext !== ".cmd" && ext !== ".bat") return { command: candidate, prefixArgs: [] };

			const target = resolveShimTarget(candidate, dir);
			if (target) return { command: process.execPath, prefixArgs: [target] };
		}
	}
	return null;
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
	// vLLM serves gpt-oss through the Responses API and everything else through
	// chat completions; the agent needs to be told which wire format to speak.
	const api = modelConfig.model.toLowerCase().includes("gpt-oss") ? "openai-responses" : "openai-completions";
	// Pods are reached over a private endpoint that usually ignores the key, but
	// the agent still requires a credential to start. "dummy" keeps that path
	// working without inventing a secret.
	const apiKey = opts.apiKey || process.env.PHI_API_KEY || process.env.PI_API_KEY || "dummy";
	const providerId = podProviderId(podName);

	const launch = resolveAgentLaunch();
	if (!launch) {
		console.error(chalk.red(`'${AGENT_COMMAND}' was not found on PATH, so the prompt cannot be started.`));
		console.error("");
		console.error(`Install the agent (${chalk.cyan(`npm i -g ${AGENT_PACKAGE}`)}), or reach the pod directly:`);
		console.error(`  ${chalk.cyan(`${baseUrl} — model ${modelConfig.model}`)}`);
		process.exit(1);
	}

	// Declare the endpoint the agent will dial. Only the endpoint is persisted:
	// the key below travels as --api-key, which the agent keeps in memory.
	try {
		const result = ensurePodProvider({
			providerId,
			displayName: `Pod ${podName}`,
			baseUrl,
			api,
			modelId: modelConfig.model,
		});
		if (result.action !== "unchanged") {
			console.error(chalk.dim(`Provider '${providerId}' ${result.action} in ${result.modelsPath} (${baseUrl}).`));
		}
		if (result.backupPath) {
			console.error(
				chalk.yellow(
					`Comments in models.json are not preserved when it is rewritten; the previous file was kept at ${result.backupPath}.`,
				),
			);
		}
	} catch (error) {
		console.error(chalk.red(`Could not declare the pod endpoint: ${error instanceof Error ? error.message : error}`));
		process.exit(1);
	}

	const args = [
		...launch.prefixArgs,
		"--model",
		`${providerId}/${modelConfig.model}`,
		"--api-key",
		apiKey,
		"--system-prompt",
		systemPrompt,
		// Everything the user typed after the model name: the message itself,
		// --continue, --mode json, and so on.
		...userArgs,
	];

	const child = spawn(launch.command, args, { stdio: "inherit", shell: false });

	child.on("error", (error) => {
		console.error(chalk.red(`Failed to start ${AGENT_COMMAND}: ${error.message}`));
		process.exit(1);
	});

	child.on("exit", (code, signal) => {
		// Report the agent's own outcome; a signal has no exit code of its own, so
		// use the shell convention rather than reporting success.
		process.exit(signal ? 128 : (code ?? 1));
	});
}
