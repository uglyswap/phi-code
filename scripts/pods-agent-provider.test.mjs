import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

/**
 * `phi-pods prompt` declares the pod endpoint in the agent's models.json, which
 * is also where every other provider's plaintext API key lives. These cases lock
 * the two properties that file deserves: nothing outside the pod's own provider
 * entry is touched, and a key handed to pods never reaches the disk.
 *
 * The built output is imported rather than the source so the check covers what
 * is actually published.
 */
const distPath = join(import.meta.dirname, "..", "packages", "pods", "dist", "agent-provider.js");

const { ensurePodProvider, getModelsPath, podProviderId } = existsSync(distPath)
	? await import(pathToFileURL(distPath).href)
	: {};

const skip = existsSync(distPath) ? false : "packages/pods is not built (run npm run build -w @phi-code-admin/pods)";

const SPEC = {
	providerId: "pod-h100",
	displayName: "Pod h100",
	baseUrl: "http://10.0.0.4:8000/v1",
	api: "openai-completions",
	modelId: "Qwen/Qwen3-32B",
};

/** Run body with a throwaway agent dir, restoring the caller's env afterwards. */
function withTempAgentDir(body) {
	const previous = process.env.PHI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "pods-agent-provider-"));
	process.env.PHI_CODING_AGENT_DIR = dir;
	try {
		return body(dir);
	} finally {
		if (previous === undefined) delete process.env.PHI_CODING_AGENT_DIR;
		else process.env.PHI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("provider id is stable for a pod name", { skip }, () => {
	assert.equal(podProviderId("h100"), "pod-h100");
});

test("creates models.json with the pod endpoint when none exists", { skip }, () => {
	withTempAgentDir(() => {
		const result = ensurePodProvider(SPEC);
		assert.equal(result.action, "created");

		const config = JSON.parse(readFileSync(getModelsPath(), "utf-8"));
		assert.deepEqual(config.providers["pod-h100"].models, [
			{ id: SPEC.modelId, baseUrl: SPEC.baseUrl, api: SPEC.api },
		]);
	});
});

test("gives each model of a pod its own endpoint", { skip }, () => {
	withTempAgentDir(() => {
		// Two vLLM instances on one pod listen on different ports. A provider-level
		// baseUrl would point both models at whichever was declared last.
		ensurePodProvider(SPEC);
		ensurePodProvider({
			...SPEC,
			modelId: "openai/gpt-oss-120b",
			baseUrl: "http://10.0.0.4:8001/v1",
			api: "openai-responses",
		});

		const config = JSON.parse(readFileSync(getModelsPath(), "utf-8"));
		const provider = config.providers["pod-h100"];
		assert.equal(provider.baseUrl, undefined, "the endpoint belongs on the model, not the provider");
		assert.deepEqual(provider.models, [
			{ id: SPEC.modelId, baseUrl: "http://10.0.0.4:8000/v1", api: "openai-completions" },
			{ id: "openai/gpt-oss-120b", baseUrl: "http://10.0.0.4:8001/v1", api: "openai-responses" },
		]);

		// Switching back to the first model must not disturb the second.
		assert.equal(ensurePodProvider(SPEC).action, "unchanged");
	});
});

test("moves a model that was restarted on another port", { skip }, () => {
	withTempAgentDir(() => {
		ensurePodProvider(SPEC);
		const result = ensurePodProvider({ ...SPEC, baseUrl: "http://10.0.0.4:9000/v1" });

		assert.equal(result.action, "updated");
		const config = JSON.parse(readFileSync(getModelsPath(), "utf-8"));
		assert.deepEqual(config.providers["pod-h100"].models, [
			{ id: SPEC.modelId, baseUrl: "http://10.0.0.4:9000/v1", api: SPEC.api },
		]);
	});
});

test("re-declaring the same endpoint does not rewrite the file", { skip }, () => {
	withTempAgentDir(() => {
		ensurePodProvider(SPEC);
		const before = readFileSync(getModelsPath(), "utf-8");

		const result = ensurePodProvider(SPEC);

		assert.equal(result.action, "unchanged");
		assert.equal(readFileSync(getModelsPath(), "utf-8"), before);
	});
});

test("keeps other providers, their keys, and hand-written fields", { skip }, () => {
	withTempAgentDir(() => {
		const modelsPath = getModelsPath();
		writeFileSync(
			modelsPath,
			`${JSON.stringify(
				{
					providers: {
						anthropic: { apiKey: "sk-ant-secret", models: [{ id: "claude-haiku-4-5" }] },
						"pod-h100": { name: "renamed by hand", headers: { "X-Tenant": "team-a" }, baseUrl: "http://stale:1/v1", api: "openai-responses", models: [{ id: "old-model" }] },
					},
				},
				null,
				2,
			)}\n`,
		);

		const result = ensurePodProvider(SPEC);
		assert.equal(result.action, "updated");

		const config = JSON.parse(readFileSync(modelsPath, "utf-8"));
		assert.equal(config.providers.anthropic.apiKey, "sk-ant-secret");
		const pod = config.providers["pod-h100"];
		assert.equal(pod.name, "renamed by hand");
		assert.deepEqual(pod.headers, { "X-Tenant": "team-a" });
		// The hand-written provider-level endpoint is left alone; the model's own
		// takes precedence in the agent, so nothing has to be removed.
		assert.equal(pod.baseUrl, "http://stale:1/v1");
		// The stale model stays listed; the new one is added alongside it.
		assert.deepEqual(pod.models, [
			{ id: "old-model" },
			{ id: SPEC.modelId, baseUrl: SPEC.baseUrl, api: SPEC.api },
		]);
	});
});

test("never writes an API key to disk", { skip }, () => {
	withTempAgentDir(() => {
		ensurePodProvider(SPEC);
		const raw = readFileSync(getModelsPath(), "utf-8");
		assert.ok(!raw.includes("apiKey"), "pods must leave credentials to the agent's --api-key overlay");
	});
});

test("accepts comments and trailing commas, backing the file up before rewriting", { skip }, () => {
	withTempAgentDir(() => {
		const modelsPath = getModelsPath();
		writeFileSync(
			modelsPath,
			['{', '  // my providers', '  "providers": {', '    "anthropic": { "apiKey": "sk-ant-secret" },', '  },', '}', ''].join("\n"),
		);

		const result = ensurePodProvider(SPEC);

		assert.equal(result.action, "created");
		assert.ok(result.backupPath, "a lossy rewrite must leave the original behind");
		assert.ok(readFileSync(result.backupPath, "utf-8").includes("// my providers"));

		const config = JSON.parse(readFileSync(modelsPath, "utf-8"));
		assert.equal(config.providers.anthropic.apiKey, "sk-ant-secret");
		assert.equal(config.providers["pod-h100"].models[0].baseUrl, SPEC.baseUrl);
	});
});

test("refuses to overwrite a models.json it cannot parse", { skip }, () => {
	withTempAgentDir(() => {
		const modelsPath = getModelsPath();
		const broken = '{ "providers": { "anthropic": ';
		writeFileSync(modelsPath, broken);

		assert.throws(() => ensurePodProvider(SPEC), /refusing to overwrite/);
		assert.equal(readFileSync(modelsPath, "utf-8"), broken);
	});
});
