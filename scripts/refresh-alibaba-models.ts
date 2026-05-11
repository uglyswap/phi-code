/**
 * Refresh Alibaba Coding Plan bundled models list (Q3 strategy C).
 *
 * Strategy: probe /v1/models with provided ALIBABA_CODING_PLAN_KEY env var,
 * compare with the bundled list in default-models.json, and regenerate
 * default-models.json with the updated list. Prints a diff for review
 * before writing.
 *
 * Usage:
 *   ALIBABA_CODING_PLAN_KEY=sk-sp-xxxxx npx tsx scripts/refresh-alibaba-models.ts
 *   ALIBABA_CODING_PLAN_KEY=sk-sp-xxxxx npx tsx scripts/refresh-alibaba-models.ts --apply
 *
 * Without --apply, the script is a dry-run that just prints the diff.
 *
 * Why a script and not runtime auto-fetch?
 *   Per Q3 decision: the public listing endpoint is not officially documented
 *   for the Coding Plan, so we prefer release-time refresh + versioned static
 *   list over runtime polling that could surprise users mid-session.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");
const DEFAULT_MODELS_PATH = join(
	REPO_ROOT,
	"packages",
	"coding-agent",
	"src",
	"core",
	"default-models.json",
);

const ALIBABA_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";

interface ModelEntry {
	id: string;
	name: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	compat?: Record<string, unknown>;
}

interface ProviderEntry {
	baseUrl: string;
	api: string;
	apiKey: string;
	models: ModelEntry[];
}

interface ModelsConfig {
	$comment?: string;
	providers: Record<string, ProviderEntry>;
}

interface AlibabaApiModel {
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
}

async function fetchModels(apiKey: string): Promise<AlibabaApiModel[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);
	try {
		const res = await fetch(`${ALIBABA_BASE_URL}/models`, {
			signal: controller.signal,
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		clearTimeout(timeout);
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}: ${await res.text()}`);
		}
		const json = (await res.json()) as { data?: AlibabaApiModel[] };
		return json.data ?? [];
	} catch (err) {
		clearTimeout(timeout);
		throw err;
	}
}

function loadConfig(): ModelsConfig {
	const raw = readFileSync(DEFAULT_MODELS_PATH, "utf-8");
	return JSON.parse(raw) as ModelsConfig;
}

function saveConfig(config: ModelsConfig): void {
	writeFileSync(DEFAULT_MODELS_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function diffSets(existing: string[], remote: string[]): { added: string[]; removed: string[] } {
	const existingSet = new Set(existing);
	const remoteSet = new Set(remote);
	const added = remote.filter((id) => !existingSet.has(id));
	const removed = existing.filter((id) => !remoteSet.has(id));
	return { added, removed };
}

async function main(): Promise<void> {
	const apiKey = process.env.ALIBABA_CODING_PLAN_KEY;
	if (!apiKey) {
		console.error("error: ALIBABA_CODING_PLAN_KEY env var is required");
		console.error("usage: ALIBABA_CODING_PLAN_KEY=sk-sp-... npx tsx scripts/refresh-alibaba-models.ts");
		process.exit(1);
	}

	const apply = process.argv.includes("--apply");

	console.log("Loading bundled default-models.json...");
	const config = loadConfig();

	const openaiProvider = config.providers["alibaba-codingplan"];
	if (!openaiProvider) {
		console.error("error: alibaba-codingplan provider missing from default-models.json");
		process.exit(1);
	}

	const existingIds = openaiProvider.models.map((m) => m.id);
	console.log(`Bundled: ${existingIds.length} models`);
	console.log(`  ${existingIds.join(", ")}`);

	console.log("\nFetching live model list from Alibaba...");
	let remoteModels: AlibabaApiModel[];
	try {
		remoteModels = await fetchModels(apiKey);
	} catch (err) {
		console.error(`error: failed to fetch models: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}

	const remoteIds = remoteModels.map((m) => m.id).sort();
	console.log(`Remote: ${remoteIds.length} models`);
	console.log(`  ${remoteIds.join(", ")}`);

	const { added, removed } = diffSets(existingIds, remoteIds);
	console.log("\nDiff:");
	console.log(`  Added (in remote, not in bundled): ${added.length}`);
	added.forEach((id) => console.log(`    + ${id}`));
	console.log(`  Removed (in bundled, not in remote): ${removed.length}`);
	removed.forEach((id) => console.log(`    - ${id}`));

	if (added.length === 0 && removed.length === 0) {
		console.log("\nNo changes. Bundled list is up to date.");
		return;
	}

	if (!apply) {
		console.log("\nDry-run. Use --apply to write changes to default-models.json.");
		return;
	}

	console.log("\nApplying changes...");
	const newModels: ModelEntry[] = [];
	for (const m of openaiProvider.models) {
		if (!removed.includes(m.id)) newModels.push(m);
	}
	for (const id of added) {
		newModels.push({
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
	}
	openaiProvider.models = newModels;

	const anthropicProvider = config.providers["alibaba-codingplan-anthropic"];
	if (anthropicProvider) {
		anthropicProvider.models = newModels.map((m) => ({
			...m,
			name: `${m.name} (Anthropic-compat)`,
			compat: { supportsLongCacheRetention: true },
		}));
	}

	saveConfig(config);
	console.log("Wrote updated default-models.json.");
	console.log("Please review the diff and adjust contextWindow/maxTokens for new models.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
