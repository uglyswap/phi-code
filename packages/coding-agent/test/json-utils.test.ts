import { describe, expect, test } from "vitest";
import { stripJsonComments } from "../src/core/json-utils.ts";

describe("stripJsonComments", () => {
	test("passes plain JSON through unchanged", () => {
		const input = `{"a": 1, "b": "two"}`;
		expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1, b: "two" });
	});

	test("strips // line comments", () => {
		const input = `{
			// api key for alibaba
			"a": 1
		}`;
		expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1 });
	});

	test("strips trailing commas in objects and arrays", () => {
		const input = `{"a": [1, 2,], "b": {"c": 3,},}`;
		expect(JSON.parse(stripJsonComments(input))).toEqual({ a: [1, 2], b: { c: 3 } });
	});

	test("leaves // and commas inside string literals untouched", () => {
		const input = `{"url": "https://example.com//path", "note": "a, b,"}`;
		expect(JSON.parse(stripJsonComments(input))).toEqual({
			url: "https://example.com//path",
			note: "a, b,",
		});
	});

	test("handles escaped quotes inside strings", () => {
		const input = `{"s": "he said \\"hi\\" // not a comment"}`;
		expect(JSON.parse(stripJsonComments(input))).toEqual({ s: 'he said "hi" // not a comment' });
	});
});
