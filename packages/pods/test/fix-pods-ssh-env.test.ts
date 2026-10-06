import { describe, expect, it } from "vitest";
import { getVllmApiKey } from "../src/api-key.ts";
import { buildModelEnvExports } from "../src/commands/models.ts";
import { buildScpArgs, getSshHost, parseSshCommand } from "../src/ssh.ts";

describe("getSshHost", () => {
	it("handles options before the destination", () => {
		expect(getSshHost("ssh -p 22 root@1.2.3.4")).toBe("1.2.3.4");
		expect(getSshHost("ssh -i ~/.ssh/key -o StrictHostKeyChecking=yes root@1.2.3.4")).toBe("1.2.3.4");
		expect(getSshHost("ssh -p2222 my-pod")).toBe("my-pod");
		expect(getSshHost("ssh ssh://root@1.2.3.4:2222")).toBe("1.2.3.4");
	});

	it("returns undefined without a destination", () => {
		expect(getSshHost("ssh -p 22")).toBeUndefined();
	});
});

describe("buildScpArgs", () => {
	it("keeps the identity file, options and port of the ssh command", () => {
		expect(buildScpArgs("ssh -p 2222 -i ~/.ssh/key -o ConnectTimeout=5 root@h", "/l/f.sh", "/tmp/f.sh")).toEqual([
			"-P",
			"2222",
			"-i",
			"~/.ssh/key",
			"-o",
			"ConnectTimeout=5",
			"/l/f.sh",
			"root@h:/tmp/f.sh",
		]);
	});

	it("does not mistake an option value for the host", () => {
		expect(buildScpArgs("ssh -i key root@h", "a", "b")).toEqual(["-i", "key", "a", "root@h:b"]);
	});

	it("turns ssh -l into a user@ destination (scp -l is a bandwidth limit)", () => {
		expect(buildScpArgs("ssh -l ubuntu -t h", "a", "b")).toEqual(["a", "ubuntu@h:b"]);
	});

	it("parses grouped boolean flags", () => {
		expect(parseSshCommand("ssh -tA root@h").options).toEqual([{ flag: "t" }, { flag: "A" }]);
	});
});

describe("getVllmApiKey", () => {
	it("prefers PHI_API_KEY and still honours PI_API_KEY", () => {
		expect(getVllmApiKey({ PHI_API_KEY: "a", PI_API_KEY: "b" })).toBe("a");
		expect(getVllmApiKey({ PI_API_KEY: "b" })).toBe("b");
		expect(getVllmApiKey({})).toBeUndefined();
		expect(getVllmApiKey({ PHI_API_KEY: "  " })).toBeUndefined();
	});
});

describe("buildModelEnvExports", () => {
	it("shell-quotes every value", () => {
		const out = buildModelEnvExports({ hfToken: "hf'$(id)", apiKey: "k'ey", gpus: [], modelEnv: { X: "a b" } });
		expect(out).toContain(`export HF_TOKEN='hf'\\''$(id)'`);
		expect(out).toContain(`export PI_API_KEY='k'\\''ey'`);
		expect(out).toContain(`export X='a b'`);
	});

	it("omits HF_TOKEN when unset instead of exporting 'undefined'", () => {
		const out = buildModelEnvExports({ apiKey: "k", gpus: [1] });
		expect(out).not.toContain("HF_TOKEN");
		expect(out).not.toContain("undefined");
		expect(out).toContain("export CUDA_VISIBLE_DEVICES='1'");
	});
});
