import { describe, expect, it, vi } from "vitest";
import { isUserAllowed, parseAccessPolicy } from "../src/access.ts";
import { resolveProviderApiKey } from "../src/api-key.ts";
import { redactSecrets } from "../src/redact.ts";
import { buildCommandEnv } from "../src/sandbox.ts";

describe("redactSecrets", () => {
	// Fake values built at runtime so no secret-shaped literal lives in the repo.
	const body = "Ab3_dE5-fG7hJ9kL1mN3pQ5rS7tU9vW";
	const samples: Record<string, string> = {
		anthropic: `sk-ant-api03-${body}`,
		openaiProject: `sk-proj-${body}`,
		openaiLegacy: `sk-${body.replace(/[-_]/g, "x")}`,
		slackBot: `xoxb-1234567890-0987654321-${body.replace(/_/g, "x")}`,
		slackApp: `xapp-1-A0123456789-${body.replace(/_/g, "x")}`,
		githubFineGrained: `github_pat_11ABCDEFG0_${body.replace(/-/g, "x")}`,
		githubClassic: `ghp_${body.replace(/[-_]/g, "x")}`,
	};

	for (const [name, secret] of Object.entries(samples)) {
		it(`removes the whole ${name} token`, () => {
			const out = redactSecrets(`value=${secret} end`);
			expect(out).toBe("value=[REDACTED] end");
			expect(out).not.toContain(body.slice(-8));
		});
	}

	it("leaves ordinary text alone", () => {
		const text = "task-runner sk-short xoxb- github_pat_ ok";
		expect(redactSecrets(text)).toBe(text);
	});
});

describe("parseAccessPolicy", () => {
	it("fails closed when MOM_ALLOWED_USERS is unset or blank", () => {
		expect(parseAccessPolicy(undefined)).toHaveProperty("error");
		expect(parseAccessPolicy("  ")).toHaveProperty("error");
	});

	it("parses a list of Slack user IDs", () => {
		const policy = parseAccessPolicy(" U012ABC , W034DEF,");
		if ("error" in policy) throw new Error(policy.error);
		expect(isUserAllowed(policy, "U012ABC")).toBe(true);
		expect(isUserAllowed(policy, "W034DEF")).toBe(true);
		expect(isUserAllowed(policy, "U999ZZZ")).toBe(false);
	});

	it("rejects entries that are not user IDs instead of ignoring them", () => {
		expect(parseAccessPolicy("U012ABC,mario")).toHaveProperty("error");
	});

	it("allows everyone only on an explicit '*'", () => {
		const policy = parseAccessPolicy("*");
		if ("error" in policy) throw new Error(policy.error);
		expect(isUserAllowed(policy, "U999ZZZ")).toBe(true);
	});
});

describe("resolveProviderApiKey", () => {
	it("asks the runtime for the provider of the model being called", async () => {
		const getAuth = vi.fn(async (provider: string) => ({ auth: { apiKey: `key-for-${provider}` } }));
		await expect(resolveProviderApiKey({ getAuth }, "openai", "/auth.json")).resolves.toBe("key-for-openai");
		expect(getAuth).toHaveBeenCalledWith("openai");
	});

	it("names the missing provider in the error", async () => {
		const getAuth = async () => undefined;
		await expect(resolveProviderApiKey({ getAuth }, "google", "/auth.json")).rejects.toThrow(
			"No API key found for google",
		);
	});
});

describe("buildCommandEnv", () => {
	it("drops mom tokens and credential-like variables but keeps the rest", () => {
		const env = buildCommandEnv({
			PATH: "/usr/bin",
			HOME: "/home/mom",
			MOM_SLACK_BOT_TOKEN: "t1",
			MOM_SLACK_APP_TOKEN: "t2",
			ANTHROPIC_API_KEY: "t3",
			OPENAI_APIKEY: "t4",
			AWS_SECRET_ACCESS_KEY: "t5",
			GH_TOKEN: "t6",
			DB_PASSWORD: "t7",
		});
		expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/mom" });
	});

	it("keeps variables the operator explicitly passes through", () => {
		const env = buildCommandEnv({ PATH: "/usr/bin", GH_TOKEN: "t6", MOM_ENV_PASSTHROUGH: " GH_TOKEN ," });
		expect(env).toEqual({ PATH: "/usr/bin", GH_TOKEN: "t6" });
	});
});
