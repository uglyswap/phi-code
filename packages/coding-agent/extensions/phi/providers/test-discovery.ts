/**
 * Targeted-test discovery — the oracle upgrade the flask-4992 measurement
 * demanded: the driver oracle validated the agent's own reproduction (exit 0)
 * while the project's REAL tests for the touched module failed. Running the
 * full suite is usually too slow/foreign (django ≠ pytest); the right-sized
 * check is the EXISTING test files that belong to the modules the change
 * touched. Pure logic with fs seams so every heuristic is unit-tested.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DiscoverySeams {
	/** Does this repo-relative path exist? */
	exists(relPath: string): boolean;
	/** package.json content (for JS runner detection); null when absent. */
	readPackageJson(): { devDependencies?: Record<string, string>; dependencies?: Record<string, string> } | null;
}

const PY_EXT = /\.py$/;
const JS_EXT = /\.(ts|tsx|js|jsx|mjs)$/;

function posix(p: string): string {
	return p.replace(/\\/g, "/");
}

/** Candidate test-file locations for one changed source file. */
export function testCandidatesFor(changedFile: string): string[] {
	const f = posix(changedFile);
	const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
	const base = f.slice(f.lastIndexOf("/") + 1);
	const stem = base.replace(/\.[^.]+$/, "");
	const d = (s: string) => (dir ? `${dir}/${s}` : s);

	if (PY_EXT.test(base)) {
		if (base.startsWith("test_")) return [f]; // a test itself
		return [
			d(`test_${base}`),
			d(`tests/test_${base}`),
			`tests/test_${stem}.py`,
			`test/test_${stem}.py`,
			// package-level tests dir next to the module's parent (e.g. pkg/mod/x.py → pkg/tests/test_x.py)
			dir.includes("/") ? `${dir.slice(0, dir.lastIndexOf("/"))}/tests/test_${stem}.py` : "",
		].filter(Boolean);
	}

	if (JS_EXT.test(base)) {
		if (/\.(test|spec)\./.test(base)) return [f];
		const exts = ["ts", "tsx", "js", "mjs"];
		const out: string[] = [];
		for (const e of exts) {
			out.push(
				d(`${stem}.test.${e}`),
				d(`__tests__/${stem}.test.${e}`),
				`test/${stem}.test.${e}`,
				`tests/${stem}.test.${e}`,
			);
		}
		return out;
	}

	return [];
}

export interface TargetedTests {
	/** Existing test files that cover the changed modules. */
	files: string[];
	/** A runnable command for them, or undefined when none could be built. */
	command?: string;
}

/**
 * Discover the existing targeted tests for a set of changed files and build one
 * command to run them. Python → pytest; JS → vitest/jest when present in
 * package.json. Deduped, capped (a huge change should not queue a full suite by
 * the back door).
 */
export function discoverTargetedTests(changedFiles: string[], seams: DiscoverySeams, cap = 5): TargetedTests {
	const found: string[] = [];
	for (const cf of changedFiles) {
		for (const cand of testCandidatesFor(cf)) {
			if (!found.includes(cand) && seams.exists(cand)) {
				found.push(cand);
				break; // first existing candidate per changed file is enough
			}
		}
		if (found.length >= cap) break;
	}
	if (found.length === 0) return { files: [] };

	if (found.every((f) => PY_EXT.test(f))) {
		return { files: found, command: `python -m pytest ${found.join(" ")} -x -q` };
	}
	const pkg = seams.readPackageJson();
	const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
	if (deps.vitest) return { files: found, command: `npx vitest run ${found.join(" ")}` };
	if (deps.jest) return { files: found, command: `npx jest ${found.join(" ")}` };
	return { files: found };
}

/** Real-fs seams for a repo root. */
export function fsSeamsFor(cwd: string): DiscoverySeams {
	return {
		exists: (rel) => {
			try {
				return existsSync(join(cwd, rel));
			} catch {
				return false;
			}
		},
		readPackageJson: () => {
			try {
				return JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
			} catch {
				return null;
			}
		},
	};
}
