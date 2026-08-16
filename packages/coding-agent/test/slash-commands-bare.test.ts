import { describe, expect, test } from "vitest";
import {
	BARE_BUILTIN_COMMAND_NAMES,
	BUILTIN_SLASH_COMMANDS,
	matchBareBuiltinWithArgs,
} from "../src/core/slash-commands.ts";

describe("matchBareBuiltinWithArgs", () => {
	test("detects a bare builtin invoked with arguments", () => {
		expect(matchBareBuiltinWithArgs("/new please")).toBe("new");
		expect(matchBareBuiltinWithArgs("/quit now")).toBe("quit");
		expect(matchBareBuiltinWithArgs("/resume yesterday's session")).toBe("resume");
	});

	test("returns null for the exact bare form (handled by the ladder)", () => {
		expect(matchBareBuiltinWithArgs("/new")).toBeNull();
		expect(matchBareBuiltinWithArgs("/quit")).toBeNull();
	});

	test("returns null for commands that take arguments", () => {
		expect(matchBareBuiltinWithArgs("/model opus")).toBeNull();
		expect(matchBareBuiltinWithArgs("/export session.html")).toBeNull();
		expect(matchBareBuiltinWithArgs("/compact keep the last plan")).toBeNull();
		expect(matchBareBuiltinWithArgs("/name my session")).toBeNull();
	});

	test("returns null for /debug (an extension owns '/debug <text>')", () => {
		expect(matchBareBuiltinWithArgs("/debug the login flow crashes")).toBeNull();
	});

	test("returns null for unknown commands and plain prose", () => {
		expect(matchBareBuiltinWithArgs("/does-not-exist args")).toBeNull();
		expect(matchBareBuiltinWithArgs("hello /new world")).toBeNull();
		expect(matchBareBuiltinWithArgs("plain message")).toBeNull();
	});

	test("every bare name is a real builtin", () => {
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));
		for (const name of BARE_BUILTIN_COMMAND_NAMES) {
			expect(builtinNames.has(name), `/${name} must exist as a builtin`).toBe(true);
		}
	});

	test("argument-taking builtins are excluded from the bare set", () => {
		for (const name of ["model", "export", "import", "name", "compact"]) {
			expect(BARE_BUILTIN_COMMAND_NAMES.has(name)).toBe(false);
		}
	});
});
