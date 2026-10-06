import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";

describe("fix-core CLI arguments", () => {
	it("treats everything after -- as messages or @files (#7269)", () => {
		const result = parseArgs(["--model", "gpt-4o", "--", "--help", "-p", "@notes.md", "hello"]);
		expect(result.model).toBe("gpt-4o");
		expect(result.help).toBeUndefined();
		expect(result.print).toBeUndefined();
		expect(result.messages).toEqual(["--help", "-p", "hello"]);
		expect(result.fileArgs).toEqual(["notes.md"]);
	});

	it("does not split a --flag=value message placed after --", () => {
		const result = parseArgs(["--model=gpt-4o", "--", "--model=other", "--thinking=high"]);
		expect(result.model).toBe("gpt-4o");
		expect(result.thinking).toBeUndefined();
		expect(result.messages).toEqual(["--model=other", "--thinking=high"]);
	});

	it("ignores empty entries in --models (#10334)", () => {
		expect(parseArgs(["--models", "gpt-4o, ,claude-sonnet,"]).models).toEqual(["gpt-4o", "claude-sonnet"]);
		expect(parseArgs(["--models=gpt-4o,"]).models).toEqual(["gpt-4o"]);
	});

	it("rejects invalid or missing --mode values (#9045)", () => {
		expect(parseArgs(["--mode", "json"]).mode).toBe("json");
		expect(parseArgs(["--mode=rpc"]).mode).toBe("rpc");

		const invalid = parseArgs(["--mode", "yaml"]);
		expect(invalid.mode).toBeUndefined();
		expect(invalid.diagnostics).toEqual([
			{ type: "error", message: 'Invalid mode "yaml". Valid values: text, json, rpc' },
		]);
		expect(invalid.messages).toEqual([]);

		const missing = parseArgs(["--mode", "--version"]);
		expect(missing.version).toBe(true);
		expect(missing.diagnostics).toEqual([{ type: "error", message: "--mode requires text, json, or rpc" }]);

		expect(parseArgs(["--mode"]).diagnostics).toEqual([
			{ type: "error", message: "--mode requires text, json, or rpc" },
		]);
		const invalidAfterValid = parseArgs(["--mode", "json", "--mode", "xml"]);
		expect(invalidAfterValid.diagnostics[0]?.type).toBe("error");
	});
});
