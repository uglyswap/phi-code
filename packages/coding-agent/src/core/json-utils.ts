/**
 * Shared helpers for user-edited JSON config files.
 *
 * models.json is documented as tolerating `//` line comments and trailing
 * commas (see docs/custom-provider.md). Every reader of that file must go
 * through the same normalization, otherwise a commented config parses in one
 * subsystem and crashes another.
 */

/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
export function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}
