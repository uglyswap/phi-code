/**
 * Background review (plan §C4).
 *
 * Triggered on `agent_settled` (NOT `agent_end` — auto-retry/queued messages),
 * throttled by tool iterations + a minimum interval, single-flight (memory +
 * `.state/review.lock`), anti-recursion via PHI_SKILL_SYSTEM_REVIEW=1 in the
 * fork env. The fork is a SUBPROCESS with a cold prompt cache — accepted price
 * of isolation; the daily budget exists for it.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "phi-code";
import { isReviewFork, loadConfig } from "./config.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { skillsRoot } from "./paths.ts";
import { resetReadMarks } from "./readmarks.ts";
import { buildReviewDigest, type DigestSkillInfo } from "./review-digest.ts";
import { listFilesRelative, readTextFile } from "./store.ts";
import { addReviewCost, readUsageFile, saveUsage, todayReviewCost } from "./usage.ts";

export const REVIEW_STANDARDS = `Examine la conversation ci-dessus et mets à jour la bibliothèque de skills. Sois ACTIF —
la plupart des sessions produisent au moins une mise à jour, même petite.

Forme cible : des skills AU NIVEAU DE LA CLASSE — SKILL.md de règles toujours actives +
petit ensemble references/ de profondeur thématique. Pas de liste plate de skills étroites
d'une seule session, pas d'umbrella qui accumule un fichier par session.

Une skill EST la procédure pour faire une classe de tâche selon les spécifications de CET
utilisateur : étapes dans l'ordre, commandes concrètes, points de décision, pièges
(généralisables + POURQUOI, à l'impératif — jamais un récit d'incident, jamais de numéro
de PR/issue, de date ou de citation utilisateur comme contenu).

Signaux : l'utilisateur a corrigé style/format/verbosité/approche ; une technique non
triviale a émergé ; une skill chargée s'est révélée fausse ou incomplète.

Ordre de préférence — choisis la première action qui convient :
1. METTRE À JOUR UNE SKILL CHARGÉE CE TOUR (recharge-la avec \`read\` — read-before-write).
2. METTRE À JOUR UNE UMBRELLA EXISTANTE.
3. AJOUTER UN FICHIER SUPPORT (references/<sujet>.md, templates/, scripts/) + pointeur d'une ligne.
4. CRÉER UNE NOUVELLE UMBRELLA AU NIVEAU DE LA CLASSE (jamais fix-X/debug-Y/numéro de PR).

Read-before-write (IMPOSÉ — skill_manage refuse sinon) : avant de patcher ou réécrire le
SKILL.md d'une skill existante, lis-la avec \`read\` pendant cette revue ; avant d'écraser un
fichier support existant, lis ce fichier. En cas de refus : lis la cible, réessaie UNE fois.

Ne supprime JAMAIS de skill ici — le curator s'en charge.

Ne PAS capturer : échecs d'environnement, affirmations négatives sur des outils, erreurs
transitoires déjà résolues, narrations one-shot, échecs non résolus.

« Nothing to save. » est une vraie option mais pas le défaut. Sinon, agis.`;

let iterationsSinceReview = 0;
let reviewInFlight = false;
let lastReviewAt = 0;
let interrupted = false;
let activeChild: ChildProcess | undefined;

export function noteToolIteration(): void {
	iterationsSinceReview++;
}

export function noteInterrupted(): void {
	interrupted = true;
}

export function resetInterrupted(): void {
	interrupted = false;
}

export function reviewState(): { iterations: number; inFlight: boolean; lastReviewAt: number } {
	return { iterations: iterationsSinceReview, inFlight: reviewInFlight, lastReviewAt };
}

function reviewLockPath(): string {
	return join(skillsRoot(), ".state", "review.lock");
}

function acquireReviewLock(timeoutMs: number): boolean {
	const path = reviewLockPath();
	try {
		writeFileSync(path, `${process.pid} ${Date.now()}`, { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
		try {
			if (Date.now() - statSync(path).mtimeMs > timeoutMs * 2) {
				unlinkSync(path);
				writeFileSync(path, `${process.pid} ${Date.now()}`, { flag: "wx" });
				return true;
			}
		} catch {
			// Raced with the holder or delete failed — treat as busy.
		}
		return false;
	}
}

function releaseReviewLock(): void {
	try {
		unlinkSync(reviewLockPath());
	} catch {
		// Already gone.
	}
}

/** Collect the available-skills index (name + description) for the digest. */
export function collectAvailableSkills(): DigestSkillInfo[] {
	const root = skillsRoot();
	const out: DigestSkillInfo[] = [];
	for (const rel of listFilesRelative(root)) {
		if (rel !== "SKILL.md" && !rel.endsWith("/SKILL.md")) continue;
		const dir = rel === "SKILL.md" ? root : join(root, ...rel.split("/").slice(0, -1));
		const name = dir.split(/[\\/]/).pop() ?? "skill";
		try {
			const parsed = parseFrontmatter(readTextFile(join(dir, "SKILL.md")));
			const description = parsed.data && typeof parsed.data.description === "string" ? parsed.data.description : "";
			out.push({ name, description });
		} catch {
			out.push({ name, description: "(unreadable)" });
		}
	}
	return out;
}

export interface ForkParseResult {
	appliedNames: string[];
	costUsd: number;
	errors: string[];
}

/** Tolerant parser for `--print --mode json` JSONL output. */
export function parseForkOutput(stdout: string): ForkParseResult {
	const result: ForkParseResult = { appliedNames: [], costUsd: 0, errors: [] };
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const visit = (node: unknown): void => {
			if (!node || typeof node !== "object") return;
			const record = node as Record<string, unknown>;
			const details = record.details;
			if (details && typeof details === "object") {
				const d = details as Record<string, unknown>;
				if (typeof d.operations_applied === "number" && d.operations_applied > 0) {
					const results = Array.isArray(d.results) ? (d.results as Array<Record<string, unknown>>) : [];
					const name = typeof results[0]?.name === "string" ? String(results[0].name) : undefined;
					if (name && !result.appliedNames.includes(name)) result.appliedNames.push(name);
				}
			}
			const usage = record.usage as Record<string, unknown> | undefined;
			if (usage) {
				const cost = usage.cost as Record<string, unknown> | undefined;
				const total = cost && typeof cost.total === "number" ? cost.total : undefined;
				if (typeof total === "number") result.costUsd += total;
			}
			if (record.type === "error" && typeof record.message === "string") result.errors.push(String(record.message));
			if (record.isError === true && typeof record.message === "string") result.errors.push(String(record.message));
		};
		visit(parsed);
	}
	return result;
}

export interface ReviewRunOptions {
	branch: Iterable<unknown>;
	loadedSkills?: readonly string[];
	hasUI: boolean;
	notify: (message: string, level?: "info" | "error" | "warning") => void;
	/** Test seam: override the fork command (defaults to the built CLI). */
	spawnImpl?: typeof spawn;
}

function forkCommand(): { command: string; baseArgs: string[] } {
	const distCli = join(getPackageDir(), "dist", "cli.js");
	if (existsSync(distCli)) return { command: process.execPath, baseArgs: [distCli] };
	return { command: "phi", baseArgs: [] };
}

function extensionEntryPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "index.ts");
}

/** Run one review fork. Returns a short status string (also used by tests). */
export async function runReviewFork(options: ReviewRunOptions): Promise<string> {
	const config = loadConfig();
	const digest = buildReviewDigest({
		branch: options.branch,
		loadedSkills: options.loadedSkills ?? [],
		availableSkills: collectAvailableSkills(),
		maxChars: config.review.maxDigestChars,
	});
	const digestPath = join(tmpdir(), `phi-skill-review-${process.pid}-${Date.now().toString(36)}.txt`);
	writeFileSync(digestPath, digest, "utf8");
	const { command, baseArgs } = forkCommand();
	const args = [
		...baseArgs,
		"--print",
		"--mode",
		"json",
		"--no-extensions",
		"--extension",
		extensionEntryPath(),
		"--tools",
		"skill_manage,read,grep,find,ls",
		"--no-skills",
		"--append-system-prompt",
		REVIEW_STANDARDS,
	];
	if (config.review.model) args.push("--model", config.review.model);
	args.push(digestPath);
	const spawnFn = options.spawnImpl ?? spawn;
	return await new Promise<string>((resolve) => {
		let stdout = "";
		let settled = false;
		const finish = (status: string): void => {
			if (settled) return;
			settled = true;
			try {
				unlinkSync(digestPath);
			} catch {
				// Digest already gone.
			}
			activeChild = undefined;
			resolve(status);
		};
		let child: ChildProcess;
		try {
			child = spawnFn(command, args, {
				env: {
					...process.env,
					PHI_SKILL_SYSTEM_REVIEW: "1",
					PHI_SKILL_SYSTEM_ALLOW_WRITE: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			finish(`fork failed to start: ${String(error)}`);
			return;
		}
		activeChild = child;
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// Already dead.
			}
			finish("timeout");
		}, config.review.timeoutSeconds * 1000);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", () => {
			// Stderr is diagnostics only — the JSON stream on stdout is the contract.
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			finish(`fork error: ${String(error)}`);
		});
		child.on("close", () => {
			clearTimeout(timer);
			const parsed = parseForkOutput(stdout);
			if (parsed.costUsd > 0) {
				const { data } = readUsageFile();
				if (data) {
					addReviewCost(data, parsed.costUsd, new Date());
					void saveUsage(data).catch(() => {
						// Cost accounting must not break the review cycle.
					});
				}
			}
			if (parsed.appliedNames.length > 0) {
				options.notify(`Skill review applied changes: ${parsed.appliedNames.join(", ")}`, "info");
				finish(`applied: ${parsed.appliedNames.join(", ")}`);
				return;
			}
			if (parsed.errors.length > 0) {
				options.notify(`Skill review failed: ${parsed.errors[0]}`, "error");
				finish(`fork reported errors: ${parsed.errors[0]}`);
				return;
			}
			finish("nothing to save");
		});
	});
}

/** Throttle + single-flight + budget, then run one fork. */
export async function maybeScheduleReview(options: ReviewRunOptions): Promise<string | undefined> {
	const config = loadConfig();
	if (!config.review.enabled) return undefined;
	if (isReviewFork()) return undefined; // Anti-recursion: never review inside a review.
	if (interrupted) return undefined;
	if (reviewInFlight) return undefined;
	if (iterationsSinceReview < config.review.nudgeInterval) return undefined;
	if (Date.now() - lastReviewAt < config.review.minIntervalSeconds * 1000) return undefined;
	const { data, unreadable } = readUsageFile();
	if (!unreadable && data && todayReviewCost(data, new Date()) >= config.review.dailyBudgetUSD) return undefined;
	if (!acquireReviewLock(config.review.timeoutSeconds * 1000)) return undefined;
	reviewInFlight = true;
	iterationsSinceReview = 0;
	lastReviewAt = Date.now();
	resetReadMarks();
	try {
		return await runReviewFork(options);
	} finally {
		reviewInFlight = false;
		releaseReviewLock();
	}
}

/** Cancel a running fork (session_shutdown); waits up to 5 s. */
export async function cancelReview(): Promise<void> {
	const child = activeChild;
	if (!child) return;
	try {
		child.kill();
	} catch {
		// Already exited.
	}
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 5000);
		child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}
