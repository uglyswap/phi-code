import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "phi-code-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import {
	readOverlayCatalog,
	resolveUpstreamById,
	upstreamKnownIds,
} from "../extensions/phi/providers/upstream-catalog.ts";

/**
 * `providers/upstream-catalog.ts` decides which models count as "upstream
 * describes it". Getting it wrong in either direction is user-visible: too
 * greedy and a models.json entry upstream needs gets deleted (the model
 * disappears from the picker), too shy and a persisted entry keeps shadowing
 * the real context window. Every case below runs offline against a
 * models-store.json fixture, so nothing here touches the network.
 */

const tempDirs: string[] = [];

/** models.json path of a fixture whose overlay lives next to it, as in production. */
function fixtureStore(store: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "phi-upstream-catalog-"));
	tempDirs.push(dir);
	const modelsJsonPath = join(dir, "models.json");
	writeFileSync(modelsJsonPath, JSON.stringify({ providers: {} }));
	writeFileSync(join(dir, "models-store.json"), JSON.stringify(store));
	return modelsJsonPath;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readOverlayCatalog", () => {
	test("reads the models of an overlay newer than the bundled snapshot", () => {
		const path = fixtureStore({
			opencode: {
				models: [{ id: "mimo-v2.6-pro", contextWindow: 1_048_576, maxTokens: 131_072 }],
				checkedAt: Date.now(),
				lastModified: Date.now(),
			},
		});
		expect(readOverlayCatalog("opencode", path).models).toEqual([
			{ id: "mimo-v2.6-pro", contextWindow: 1_048_576, maxTokens: 131_072 },
		]);
	});

	test("ignores an overlay the runtime discards as older than the bundled catalog", () => {
		// `withRemoteCatalog` keeps the bundled definitions when the remote body is
		// not newer, so treating those models as upstream-known would delete a
		// models.json entry that is still the only source for the model.
		const path = fixtureStore({
			opencode: { models: [{ id: "mimo-v2.6-pro", contextWindow: 1_048_576 }], lastModified: 1 },
		});
		expect(readOverlayCatalog("opencode", path).models).toEqual([]);
	});

	test("survives a missing store and skips entries without a usable id or window", () => {
		expect(readOverlayCatalog("opencode", join(tmpdir(), "phi-absent", "models.json")).models).toEqual([]);
		const path = fixtureStore({
			opencode: {
				models: [{ contextWindow: 1_048_576 }, "junk", { id: "" }, { id: "no-metadata" }],
				lastModified: Date.now(),
			},
		});
		expect(readOverlayCatalog("opencode", path).models).toEqual([]);
	});
});

describe("upstreamKnownIds", () => {
	test("unions the bundled catalog with the overlay", async () => {
		const path = fixtureStore({
			opencode: { models: [{ id: "only-in-overlay", contextWindow: 1_000_000 }], lastModified: Date.now() },
		});
		const known = await upstreamKnownIds("opencode", { modelsJsonPath: path, offline: true });

		expect(known.has("only-in-overlay")).toBe(true);
		const bundled = (getModels("opencode") as Array<{ id: string }>).map((model) => model.id);
		expect(bundled.length).toBeGreaterThan(0);
		for (const id of bundled) expect(known.has(id)).toBe(true);
	});

	test("a provider with no catalog entry yields an empty set instead of throwing", async () => {
		const path = fixtureStore({});
		await expect(upstreamKnownIds("not-a-real-provider", { modelsJsonPath: path, offline: true })).resolves.toEqual(
			new Set(),
		);
	});
});

describe("resolveUpstreamById", () => {
	test("finds the window another provider's catalog publishes for the same model id", async () => {
		const path = fixtureStore({
			xai: { models: [{ id: "grok-4.7", contextWindow: 500_000, maxTokens: 500_000 }], lastModified: Date.now() },
		});
		const resolved = await resolveUpstreamById(new Set(["grok-4.7"]), ["opencode"], {
			modelsJsonPath: path,
			offline: true,
		});

		expect(resolved.get("grok-4.7")).toEqual({ id: "grok-4.7", contextWindow: 500_000, maxTokens: 500_000 });
	});

	test("never resolves from an excluded provider and ignores unknown ids", async () => {
		const path = fixtureStore({
			opencode: { models: [{ id: "local-only", contextWindow: 1_000_000 }], lastModified: Date.now() },
		});
		const resolved = await resolveUpstreamById(new Set(["local-only", "nowhere"]), ["opencode"], {
			modelsJsonPath: path,
			offline: true,
		});

		expect(resolved.size).toBe(0);
	});
});
