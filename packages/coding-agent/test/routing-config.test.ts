import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SmartRouter } from "sigma-agents";
import { describe, expect, it } from "vitest";

/**
 * config/routing.example.json is documentation for hand-editing
 * ~/.phi/agent/routing.json. The single source of truth for defaults is
 * SmartRouter.defaultConfig() — this suite fails if the two ever drift.
 */
describe("routing config single source of truth", () => {
	const configDir = join(__dirname, "..", "config");

	it("routing.example.json matches SmartRouter.defaultConfig()", () => {
		const raw = JSON.parse(readFileSync(join(configDir, "routing.example.json"), "utf-8"));
		const { $schema, ...example } = raw;
		expect($schema).toBe("./routing.schema.json");
		expect(example).toEqual(SmartRouter.defaultConfig());
	});

	it("defaultConfig passes the runtime validator", () => {
		expect(SmartRouter.validateRoutingConfig(SmartRouter.defaultConfig())).toBe(true);
	});

	it("routing.schema.json is valid JSON and documents the required shape", () => {
		const schema = JSON.parse(readFileSync(join(configDir, "routing.schema.json"), "utf-8"));
		expect(schema.required).toEqual(["routes"]);
		expect(schema.properties.routes).toBeDefined();
		expect(schema.properties.default).toBeDefined();
	});
});
