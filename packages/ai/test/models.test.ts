import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/models.js";

describe("getModel", () => {
	it("returns the model for a known provider/id pair", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(model.provider).toBe("anthropic");
		expect(model.id).toBe("claude-sonnet-4-5");
	});

	it("returns undefined for an unknown model id passed as a runtime string", () => {
		const provider: string = "anthropic";
		const modelId: string = "model-that-does-not-exist";
		expect(getModel(provider, modelId)).toBeUndefined();
	});

	it("returns undefined for an unknown provider passed as a runtime string", () => {
		const provider: string = "no-such-provider";
		const modelId: string = "whatever";
		expect(getModel(provider, modelId)).toBeUndefined();
	});
});

describe("getModels", () => {
	it("returns an empty array for an unknown provider", () => {
		expect(getModels("no-such-provider" as Parameters<typeof getModels>[0])).toEqual([]);
	});
});
