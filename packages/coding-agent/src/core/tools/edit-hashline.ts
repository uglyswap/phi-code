import { createHash } from "crypto";

// Local copy of edit-diff's fuzzy normalization, duplicated to avoid an
// import cycle (edit-diff.ts imports this module for anchor recovery).
function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/**
 * Hashline-style anchor recovery for the edit tool.
 *
 * When exact and whitespace-fuzzy matching both fail (the file drifted since
 * the model read it: lines edited, shifted, or partially rewritten), we anchor
 * each line of oldText by a short content hash and look for the window of the
 * file with the highest anchor hit rate. The replacement is only applied when
 * the best window is unambiguous (clear margin over the runner-up).
 */

export interface AnchorRecoveryResult {
	found: boolean;
	/** Start line (0-based) of the recovered window in the content */
	startLine: number;
	/** End line (0-based, exclusive) of the recovered window */
	endLine: number;
	/** Fraction of oldText lines whose hash appears in the window (0-1) */
	score: number;
	/** True when two windows score too close to pick safely */
	ambiguous: boolean;
}

const NOT_FOUND: AnchorRecoveryResult = { found: false, startLine: -1, endLine: -1, score: 0, ambiguous: false };

/** Short content hash of one normalized line (trailing whitespace stripped). */
export function lineAnchor(line: string): string {
	return createHash("sha1").update(normalizeForFuzzyMatch(line).trimEnd()).digest("hex").slice(0, 8);
}

/** Map of hash -> line numbers for a document. */
export function computeAnchors(content: string): Map<string, number[]> {
	const map = new Map<string, number[]>();
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const h = lineAnchor(lines[i]);
		const list = map.get(h);
		if (list) list.push(i);
		else map.set(h, [i]);
	}
	return map;
}

/** Minimum anchor hit rate for a recovery to be considered. */
export const RECOVERY_THRESHOLD = 0.6;
/** Minimum relative margin between best and second-best window. */
export const AMBIGUITY_MARGIN = 0.15;

/**
 * Recover the position of oldText in content by line anchors.
 * oldText must span at least 2 non-empty lines; single-line recovery is left
 * to the exact/fuzzy matchers (single short lines are too ambiguous).
 */
export function recoverByAnchors(content: string, oldText: string): AnchorRecoveryResult {
	const oldLines = oldText.split("\n").filter((l) => l.trim().length > 0);
	if (oldLines.length < 2) return NOT_FOUND;

	const contentLines = content.split("\n");
	if (contentLines.length === 0) return NOT_FOUND;

	const anchors = computeAnchors(content);
	const span = oldText.split("\n").length;

	// Score every candidate window. A window is anchored at any line that
	// matches at least one oldText anchor hash; we then count how many of the
	// oldText hashes appear inside [start, start+span).
	const candidates: Array<{ start: number; hits: number }> = [];
	const oldHashes = oldLines.map(lineAnchor);

	const seenStarts = new Set<number>();
	for (const h of oldHashes) {
		for (const lineNo of anchors.get(h) ?? []) {
			// Consider windows where this matched line could plausibly align:
			// try it as the first line of the window.
			if (seenStarts.has(lineNo)) continue;
			seenStarts.add(lineNo);
			const end = Math.min(lineNo + span, contentLines.length);
			let hits = 0;
			for (const oh of oldHashes) {
				for (let i = lineNo; i < end; i++) {
					if (lineAnchor(contentLines[i]) === oh) {
						hits++;
						break;
					}
				}
			}
			candidates.push({ start: lineNo, hits });
		}
	}

	if (candidates.length === 0) return NOT_FOUND;

	candidates.sort((a, b) => b.hits - a.hits);
	const best = candidates[0];
	const score = best.hits / oldHashes.length;
	if (score < RECOVERY_THRESHOLD) return NOT_FOUND;

	const second = candidates.length > 1 ? candidates[1].hits / oldHashes.length : 0;
	if (score - second < AMBIGUITY_MARGIN && candidates[1].start !== best.start) {
		return { ...NOT_FOUND, ambiguous: true, score };
	}

	return { found: true, startLine: best.start, endLine: Math.min(best.start + span, contentLines.length), score, ambiguous: false };
}

/**
 * Replace the recovered window [startLine, endLine) of content with newText.
 * Returns the new content. Callers must have validated recovery.found first.
 */
export function applyRecoveredWindow(content: string, recovery: AnchorRecoveryResult, newText: string): string {
	const lines = content.split("\n");
	const replacement = newText.split("\n");
	lines.splice(recovery.startLine, recovery.endLine - recovery.startLine, ...replacement);
	return lines.join("\n");
}
