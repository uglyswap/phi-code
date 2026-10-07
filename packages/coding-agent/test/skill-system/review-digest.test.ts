/**
 * Review digest tests (plan §6.1): user-correction extraction, secret masking,
 * budget truncation order.
 */

import { describe, expect, it } from "vitest";
import { buildReviewDigest, maskSecrets } from "../../extensions/phi/skill-system/review-digest.ts";

function branchWith(messages: Array<Record<string, unknown>>): unknown[] {
	return messages.map((message) => ({ type: "message", message }));
}

describe("review digest", () => {
	it("extracts user corrections and includes them in the digest", () => {
		const branch = branchWith([
			{ role: "user", content: [{ type: "text", text: "stop doing that, it is too verbose" }] },
			{ role: "assistant", content: [{ type: "text", text: "Understood." }] },
		]);
		const digest = buildReviewDigest({ branch, loadedSkills: ["docker-ops"], availableSkills: [], maxChars: 50_000 });
		expect(digest).toContain("CORRECTIONS UTILISATEUR");
		expect(digest).toContain("too verbose");
		expect(digest).toContain("docker-ops");
	});

	it("masks secrets before writing", () => {
		const branch = branchWith([
			{
				role: "user",
				content: [
					{ type: "text", text: "my key is sk-abcdefghijklmnopqrstuvwx and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" },
				],
			},
		]);
		const digest = buildReviewDigest({ branch, loadedSkills: [], availableSkills: [], maxChars: 50_000 });
		expect(digest).not.toContain("sk-abcdefghijklmnopqrstuvwx");
		expect(digest).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
		expect(digest).toContain("«redacted»");
	});

	it("masks secrets directly", () => {
		expect(maskSecrets("token sk-1234567890abcdef")).toContain("«redacted»");
	});

	it("truncates to the budget, dropping recent exchanges first", () => {
		const messages = Array.from({ length: 40 }, (_, index) => ({
			role: "user",
			content: [{ type: "text", text: `message ${index} ${"x".repeat(200)}` }],
		}));
		const digest = buildReviewDigest({
			branch: branchWith(messages),
			loadedSkills: [],
			availableSkills: [],
			maxChars: 2000,
		});
		expect(digest.length).toBeLessThanOrEqual(2000);
		// The header survives even when the tail is cut.
		expect(digest).toContain("SKILLS CHARGÉES CE TOUR");
	});

	it("pairs tool failures with their recovery", () => {
		const branch = branchWith([
			{
				role: "toolResult",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "command not found" }],
			},
			{ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] },
		]);
		const digest = buildReviewDigest({ branch, loadedSkills: [], availableSkills: [], maxChars: 50_000 });
		expect(digest).toContain("ÉCHECS ET RÉCUPÉRATIONS");
		expect(digest).toContain("command not found");
		expect(digest).toContain("récupéré via bash");
	});
});
