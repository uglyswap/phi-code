import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { ApiKeyStore } from "../src/core/api-key-store.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { FileModelsStore } from "../src/core/models-store.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { parseFrontmatter } from "../src/utils/frontmatter.ts";
import { splitBom, stripBom } from "../src/utils/text.ts";

const BOM = "﻿";

describe("fix-core #8337 UTF-8 BOM in configuration files", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "phi-fix-core-bom-"));
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("splits and strips only a leading BOM", () => {
		expect(splitBom(`${BOM}content`)).toEqual({ bom: BOM, text: "content" });
		expect(splitBom("content")).toEqual({ bom: "", text: "content" });
		expect(stripBom(`a${BOM}`)).toBe(`a${BOM}`);
	});

	it("parses frontmatter preceded by a BOM", () => {
		const document = "---\nname: demo\ndescription: Test\n---\nBody";
		expect(parseFrontmatter(`${BOM}${document}`)).toEqual({
			frontmatter: { name: "demo", description: "Test" },
			body: "Body",
		});
	});

	it("loads global and project settings with a BOM and writes them back without it", async () => {
		const agentDir = join(testDir, "agent");
		const projectDir = join(testDir, "project");
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const globalSettingsPath = join(agentDir, "settings.json");
		writeFileSync(globalSettingsPath, `${BOM}${JSON.stringify({ defaultModel: "global-model" })}`);
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			`${BOM}${JSON.stringify({ defaultProvider: "project-provider" })}`,
		);

		const settings = SettingsManager.create(projectDir, agentDir);
		expect(settings.getDefaultModel()).toBe("global-model");
		expect(settings.getDefaultProvider()).toBe("project-provider");

		settings.setTheme("dark");
		await settings.flush();
		expect(readFileSync(globalSettingsPath, "utf-8").startsWith(BOM)).toBe(false);
	});

	it("reads auth.json with a BOM", async () => {
		const authPath = join(testDir, "auth.json");
		writeFileSync(authPath, `${BOM}${JSON.stringify({ demo: { type: "api_key", key: "test-key" } })}`);
		const storage = AuthStorage.create(authPath);
		expect(await storage.read("demo")).toMatchObject({ type: "api_key", key: "test-key" });
	});

	it("reads trust.json with a BOM", () => {
		const projectDir = join(testDir, "project");
		mkdirSync(projectDir, { recursive: true });
		const store = new ProjectTrustStore(testDir);
		store.set(projectDir, true);
		const trustPath = join(testDir, "trust.json");
		writeFileSync(trustPath, `${BOM}${readFileSync(trustPath, "utf-8")}`);
		expect(store.get(projectDir)).toBe(true);
	});

	it("reads keybindings.json with a BOM", () => {
		writeFileSync(join(testDir, "keybindings.json"), `${BOM}${JSON.stringify({ "app.exit": "ctrl+q" })}`);
		const manager = KeybindingsManager.create(testDir);
		expect(manager.getEffectiveConfig()["app.exit"]).toEqual("ctrl+q");
	});

	it("reads models-store.json and models.json (api-key-store) with a BOM", async () => {
		const storePath = join(testDir, "models-store.json");
		writeFileSync(storePath, `${BOM}${JSON.stringify({ demo: { models: [] } })}`);
		expect(await new FileModelsStore(storePath).read("demo")).toBeDefined();

		const modelsPath = join(testDir, "models.json");
		writeFileSync(modelsPath, `${BOM}${JSON.stringify({ providers: { demo: { apiKey: "x" } } })}`);
		const keys = new ApiKeyStore({ configPath: modelsPath });
		expect(Object.keys(keys.load().providers)).toEqual(["demo"]);
	});
});
