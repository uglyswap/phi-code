import { describe, expect, test } from "vitest";
import { formatWindow, parseContextWindow } from "../extensions/phi/providers/context-window.js";

describe("parseContextWindow", () => {
	test("parses k / m suffixes (case-insensitive)", () => {
		expect(parseContextWindow("256k")).toBe(256_000);
		expect(parseContextWindow("256K")).toBe(256_000);
		expect(parseContextWindow("1m")).toBe(1_000_000);
		expect(parseContextWindow("1M")).toBe(1_000_000);
		expect(parseContextWindow("1.5m")).toBe(1_500_000);
		expect(parseContextWindow("200 k")).toBe(200_000);
	});

	test("parses bare integers", () => {
		expect(parseContextWindow("200000")).toBe(200_000);
		expect(parseContextWindow("128000")).toBe(128_000);
	});

	test("rejects invalid or non-positive input", () => {
		expect(parseContextWindow("")).toBeUndefined();
		expect(parseContextWindow("abc")).toBeUndefined();
		expect(parseContextWindow("0")).toBeUndefined();
		expect(parseContextWindow("-5k")).toBeUndefined();
		expect(parseContextWindow("1g")).toBeUndefined();
	});
});

describe("formatWindow", () => {
	test("formats k and M compactly", () => {
		expect(formatWindow(256_000)).toBe("256k");
		expect(formatWindow(128_000)).toBe("128k");
		expect(formatWindow(1_000_000)).toBe("1M");
		expect(formatWindow(1_500_000)).toBe("1.5M");
		expect(formatWindow(2_000_000)).toBe("2M");
	});

	test("round-trips with parseContextWindow", () => {
		for (const v of [128_000, 200_000, 256_000, 1_000_000]) {
			expect(parseContextWindow(formatWindow(v))).toBe(v);
		}
	});
});
