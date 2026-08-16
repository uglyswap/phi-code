import { describe, expect, test } from "vitest";
import { ALIBABA_ENV_VAR, ALIBABA_MODELS } from "../extensions/phi/providers/alibaba.ts";
import { getProviderCatalog } from "../extensions/phi/providers/catalog.ts";

describe("provider catalog (shared by /setup, /phi-init, /benchmark)", () => {
	const catalog = getProviderCatalog();

	test("provider ids are unique", () => {
		const ids = catalog.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("every entry has the required fields", () => {
		for (const p of catalog) {
			expect(p.id.length).toBeGreaterThan(0);
			expect(p.displayName.length).toBeGreaterThan(0);
			expect(p.envVar.length).toBeGreaterThan(0);
			expect(p.baseUrl).toMatch(/^https?:\/\//);
			expect(p.api.length).toBeGreaterThan(0);
		}
	});

	test("local entries are flagged and have a probe URL", () => {
		const locals = catalog.filter((p) => p.local);
		expect(locals.map((p) => p.id).sort()).toEqual(["lm-studio", "ollama"]);
		for (const p of locals) {
			expect(p.probeUrl).toMatch(/^http:\/\/localhost:/);
		}
	});

	test("alibaba entry stays in sync with the alibaba provider module", () => {
		const alibaba = catalog.find((p) => p.id === "alibaba-codingplan");
		expect(alibaba).toBeDefined();
		expect(alibaba?.envVar).toBe(ALIBABA_ENV_VAR);
		expect(alibaba?.staticModels).toEqual(ALIBABA_MODELS.map((m) => m.id));
	});

	test("benchModels are a subset of staticModels (no phantom bench targets)", () => {
		for (const p of catalog) {
			if (!p.benchModels || p.staticModels.length === 0) continue;
			for (const id of p.benchModels) {
				expect(p.staticModels, `${p.id} bench model ${id}`).toContain(id);
			}
		}
	});

	test("cloud providers the benchmark exercises expose bench models", () => {
		const withBench = catalog.filter((p) => (p.benchModels?.length ?? 0) > 0).map((p) => p.id);
		expect(withBench).toEqual(["alibaba-codingplan", "openai"]);
	});
});
