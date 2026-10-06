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
	/**
	 * Similarity of the window with oldText (0-1): matched non-empty lines divided by
	 * the larger of the oldText and window non-empty line counts, so it bounds both the
	 * share of oldText found and the share of the window the model has seen.
	 */
	score: number;
	/** True when two windows score too close to pick safely */
	ambiguous: boolean;
	/**
	 * Non-empty lines of the window that match no oldText line: content the model
	 * never saw and that the replacement overwrites. Callers must report it.
	 */
	unmatchedWindowLines: number;
}

const NOT_FOUND: AnchorRecoveryResult = {
	found: false,
	startLine: -1,
	endLine: -1,
	score: 0,
	ambiguous: false,
	unmatchedWindowLines: 0,
};

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

const isBlank = (line: string): boolean => line.trim().length === 0;

/** Count non-empty lines shared by both hash lists, each line used at most once. */
function countMatchedLines(oldHashes: string[], windowHashes: string[]): number {
	const remaining = new Map<string, number>();
	for (const h of windowHashes) remaining.set(h, (remaining.get(h) ?? 0) + 1);
	let matched = 0;
	for (const h of oldHashes) {
		const count = remaining.get(h) ?? 0;
		if (count > 0) {
			matched++;
			remaining.set(h, count - 1);
		}
	}
	return matched;
}

/**
 * Recover the position of oldText in content by line anchors.
 * oldText must span at least 2 non-empty lines; single-line recovery is left
 * to the exact/fuzzy matchers (single short lines are too ambiguous).
 *
 * Safety rules: the first and last non-empty lines of oldText must both match the
 * boundaries of the window (so the replacement can neither slide past the region
 * the model saw nor swallow neighbouring lines), leading/trailing blank lines of
 * oldText must be blank in the file too, and the window may not grow or shrink by
 * more than the tolerated drift.
 */
export function recoverByAnchors(content: string, oldText: string): AnchorRecoveryResult {
	const allOldLines = oldText.split("\n");
	let leadingBlank = 0;
	while (leadingBlank < allOldLines.length && isBlank(allOldLines[leadingBlank])) leadingBlank++;
	let trailingBlank = 0;
	while (
		trailingBlank < allOldLines.length - leadingBlank &&
		isBlank(allOldLines[allOldLines.length - 1 - trailingBlank])
	) {
		trailingBlank++;
	}
	const coreOldLines = allOldLines.slice(leadingBlank, allOldLines.length - trailingBlank);
	const oldHashes = coreOldLines.filter((l) => !isBlank(l)).map(lineAnchor);
	if (oldHashes.length < 2) return NOT_FOUND;

	const contentLines = content.split("\n");
	const contentHashes = contentLines.map(lineAnchor);
	const firstHash = oldHashes[0];
	const lastHash = oldHashes[oldHashes.length - 1];
	const coreSpan = coreOldLines.length;
	const tolerance = Math.ceil(coreSpan * (1 - RECOVERY_THRESHOLD));
	const minSpan = Math.max(2, coreSpan - tolerance);
	const maxSpan = coreSpan + tolerance;

	const candidates: Array<{ start: number; end: number; score: number; unmatched: number }> = [];
	for (let start = 0; start < contentLines.length; start++) {
		if (contentHashes[start] !== firstHash || isBlank(contentLines[start])) continue;
		const lastEnd = Math.min(start + maxSpan - 1, contentLines.length - 1);
		for (let end = start + minSpan - 1; end <= lastEnd; end++) {
			if (contentHashes[end] !== lastHash || isBlank(contentLines[end])) continue;
			const windowStart = start - leadingBlank;
			const windowEnd = end + 1 + trailingBlank;
			if (windowStart < 0 || windowEnd > contentLines.length) continue;
			let blankBoundaries = true;
			for (let i = windowStart; i < start; i++) blankBoundaries &&= isBlank(contentLines[i]);
			for (let i = end + 1; i < windowEnd; i++) blankBoundaries &&= isBlank(contentLines[i]);
			if (!blankBoundaries) continue;

			const windowHashes: string[] = [];
			for (let i = start; i <= end; i++) {
				if (!isBlank(contentLines[i])) windowHashes.push(contentHashes[i]);
			}
			const matched = countMatchedLines(oldHashes, windowHashes);
			candidates.push({
				start: windowStart,
				end: windowEnd,
				score: matched / Math.max(oldHashes.length, windowHashes.length),
				unmatched: windowHashes.length - matched,
			});
		}
	}

	if (candidates.length === 0) return NOT_FOUND;

	candidates.sort((a, b) => b.score - a.score);
	const best = candidates[0];
	if (best.score < RECOVERY_THRESHOLD) return NOT_FOUND;

	// Every candidate is a distinct window, so any runner-up within the margin is a
	// genuine alternative location (or extent) and the choice would be a guess.
	const second = candidates.length > 1 ? candidates[1].score : 0;
	if (best.score - second < AMBIGUITY_MARGIN) {
		return { ...NOT_FOUND, ambiguous: true, score: best.score };
	}

	return {
		found: true,
		startLine: best.start,
		endLine: best.end,
		score: best.score,
		ambiguous: false,
		unmatchedWindowLines: best.unmatched,
	};
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
