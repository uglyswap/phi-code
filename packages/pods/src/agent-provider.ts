/**
 * Bridge between a pod's OpenAI-compatible endpoint and the coding agent.
 *
 * The agent used to take an endpoint on the command line (`--base-url`, `--api`).
 * It does not any more: an endpoint is described by a provider entry in
 * ~/.phi/agent/models.json, and the CLI only selects one by id. So `prompt` now
 * declares the pod as a provider once, then launches the agent against it.
 *
 * Only the endpoint is written to disk. The API key stays in memory: the agent
 * takes it through `--api-key`, which is a non-persistent runtime overlay, so a
 * key passed to a pod never lands in a config file.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One model of a provider, carrying its own endpoint. */
interface PodModelEntry {
	id: string;
	baseUrl?: string;
	api?: string;
	[key: string]: unknown;
}

/** Provider entry as models.json describes it (only the fields pods writes). */
interface PodProviderEntry {
	name: string;
	models: PodModelEntry[];
	[key: string]: unknown;
}

interface ModelsJson {
	providers: Record<string, PodProviderEntry | Record<string, unknown>>;
	[key: string]: unknown;
}

export interface PodProviderSpec {
	providerId: string;
	displayName: string;
	baseUrl: string;
	api: string;
	modelId: string;
}

export interface EnsureProviderResult {
	/** What changed on disk, so the caller can tell the user. */
	action: "unchanged" | "created" | "updated";
	modelsPath: string;
	/** Set when a lossy rewrite happened, holding the backup path. */
	backupPath?: string;
}

/**
 * Where the agent keeps its config.
 *
 * Mirrors getAgentDir() in the coding agent (config.ts): PHI_CODING_AGENT_DIR
 * wins, otherwise ~/.phi/agent. Duplicated rather than imported because pods
 * ships standalone and must not drag the agent in as a dependency.
 */
export function getAgentDir(): string {
	const envDir = process.env.PHI_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir.replace(/^~(?=$|[/\\])/, homedir());
	return join(homedir(), ".phi", "agent");
}

export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Provider id a pod is registered under. Stable, so re-running is a no-op. */
export function podProviderId(podName: string): string {
	return `pod-${podName}`;
}

/**
 * models.json tolerates `//` comments and trailing commas; JSON.parse does not.
 * Same two passes the agent uses in utils/json.ts, kept identical on purpose so
 * a file the agent accepts is a file pods accepts.
 */
function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

function hasComments(raw: string): boolean {
	return stripJsonComments(raw) !== raw;
}

function readModelsJson(path: string): { config: ModelsJson; raw: string | undefined } {
	if (!existsSync(path)) return { config: { providers: {} }, raw: undefined };

	const raw = readFileSync(path, "utf-8");
	if (raw.trim().length === 0) return { config: { providers: {} }, raw };

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(raw));
	} catch (error) {
		throw new Error(
			`${path} is not valid JSON, refusing to overwrite it: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`${path} must contain a JSON object, refusing to overwrite it`);
	}
	const config = parsed as ModelsJson;
	if (typeof config.providers !== "object" || config.providers === null) config.providers = {};
	return { config, raw };
}

/**
 * Atomic write, mirroring the agent's own persist(): tmp file with restrictive
 * permissions, then rename. models.json holds plaintext credentials for other
 * providers, so it must never widen while pods rewrites it.
 */
function writeModelsJson(path: string, config: ModelsJson): void {
	const isPosix = process.platform !== "win32";
	mkdirSync(dirname(path), isPosix ? { recursive: true, mode: 0o700 } : { recursive: true });
	const tmpPath = `${path}.tmp`;
	writeFileSync(
		tmpPath,
		`${JSON.stringify(config, null, 2)}\n`,
		isPosix ? { encoding: "utf-8", mode: 0o600 } : "utf-8",
	);
	renameSync(tmpPath, path);
	if (isPosix) {
		try {
			chmodSync(path, 0o600);
		} catch {
			// chmod fails on some filesystems (eg WSL mounts); the rename already succeeded.
		}
	}
}

function entryMatches(existing: unknown, spec: PodProviderSpec): boolean {
	if (typeof existing !== "object" || existing === null) return false;
	const entry = existing as Partial<PodProviderEntry>;
	if (!Array.isArray(entry.models)) return false;
	const model = entry.models.find((candidate) => candidate?.id === spec.modelId);
	return model?.baseUrl === spec.baseUrl && model?.api === spec.api;
}

/**
 * Declare the pod endpoint in models.json, touching nothing else.
 *
 * The endpoint is written on the model, not on the provider: one pod serves
 * several models, each vLLM instance on its own port, so a provider-level
 * baseUrl would send every model to whichever port was configured last. The
 * agent reads the model's own baseUrl first (provider-composer.ts), which is
 * also how the built-in multi-endpoint providers are described.
 *
 * Idempotent: an entry that already describes this endpoint is left exactly as
 * it is, so the common case never rewrites the file. Everything else is
 * preserved — sibling models, and any field a user added by hand (headers,
 * compat flags, a provider-level name).
 */
export function ensurePodProvider(spec: PodProviderSpec): EnsureProviderResult {
	const modelsPath = getModelsPath();
	const { config, raw } = readModelsJson(modelsPath);
	const existing = config.providers[spec.providerId];

	if (entryMatches(existing, spec)) return { action: "unchanged", modelsPath };

	const previous = (typeof existing === "object" && existing !== null ? existing : {}) as Partial<PodProviderEntry>;
	const models: PodModelEntry[] = Array.isArray(previous.models) ? [...previous.models] : [];
	const index = models.findIndex((model) => model?.id === spec.modelId);
	const model: PodModelEntry = {
		...(index >= 0 ? models[index] : {}),
		id: spec.modelId,
		baseUrl: spec.baseUrl,
		api: spec.api,
	};
	if (index >= 0) models[index] = model;
	else models.push(model);

	config.providers[spec.providerId] = {
		...previous,
		name: previous.name ?? spec.displayName,
		models,
	};

	// A rewrite serializes the parsed object, which cannot carry `//` comments
	// back. Keep a copy of the original rather than dropping the user's notes.
	let backupPath: string | undefined;
	if (raw !== undefined && hasComments(raw)) {
		backupPath = `${modelsPath}.bak`;
		writeFileSync(backupPath, raw, process.platform === "win32" ? "utf-8" : { encoding: "utf-8", mode: 0o600 });
	}

	writeModelsJson(modelsPath, config);
	return { action: existing ? "updated" : "created", modelsPath, backupPath };
}
