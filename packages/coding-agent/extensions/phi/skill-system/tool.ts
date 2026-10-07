/**
 * `skill_manage` — atomic batch engine (plan §C1).
 *
 * Pipeline order is fixed (validation before any side effect):
 *   input checks -> side-effect-free validation -> clobber guard -> gate ->
 *   lock fence -> snapshots -> sequential apply -> lint/ledger/usage.
 * Any failure rolls the whole batch back; a failed rollback keeps the snapshot
 * directory for manual recovery.
 */

import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "phi-code";
import { allowWriteOverride, isReviewFork, loadConfig } from "./config.ts";
import { stageBatch } from "./gate.ts";
import { appendEntry, captureFiles, type LedgerActor, newEntryId } from "./ledger.ts";
import { introducedFindings, type LintFinding, lintSkill } from "./linter.ts";
import { acquireLocks } from "./lock.ts";
import { archiveDir, locateSkillDir, skillsRoot } from "./paths.ts";
import { readMarkError, resetReadMarks } from "./readmarks.ts";
import {
	atomicWriteFile,
	copyTree,
	dirExists,
	fileExists,
	listFilesRelative,
	moveTree,
	readTextFile,
	removeTree,
} from "./store.ts";
import { canDeleteAutonomously, isCuratorManaged, readUsageFile, saveUsage, seedIfMissing } from "./usage.ts";
import {
	opShapeError,
	validateCategory,
	validateFileContent,
	validateFilePath,
	validateSkillContent,
	validateSkillName,
} from "./validate.ts";

export type SkillOp = Record<string, unknown> & { action: string; name?: string };

export interface OperationResult {
	success: boolean;
	action: string;
	name: string;
	path?: string;
	message: string;
	lint_warnings?: LintFinding[];
	_change?: string;
}

export interface BatchOutcome {
	success: boolean;
	operations_applied: number;
	failed_index?: number;
	completed_before_failure?: number;
	results: OperationResult[];
	staged?: boolean;
	staged_id?: string;
	error?: string;
}

export type SkillOrigin = "foreground" | "background_review" | "curator";

export interface ExecuteBatchOptions {
	origin: SkillOrigin;
	bypassGate?: boolean;
	actor?: LedgerActor;
	sessionId?: string;
}

const CreateOp = Type.Object(
	{
		action: Type.Literal("create"),
		name: Type.String({ description: "Skill name (equals the directory name)" }),
		content: Type.String({ description: "Full SKILL.md text with YAML frontmatter" }),
		category: Type.Optional(Type.String({ description: "Optional single-segment category folder" })),
	},
	{ additionalProperties: false },
);

const PatchTargetedOp = Type.Object(
	{
		action: Type.Literal("patch"),
		name: Type.String(),
		old_string: Type.String({ description: "Exact text to find (must exist — read the file first)" }),
		new_string: Type.String({ description: "Replacement text (may be empty)" }),
		replace_all: Type.Optional(Type.Boolean()),
		file_path: Type.Optional(Type.String({ description: "Default: SKILL.md" })),
	},
	{ additionalProperties: false },
);

const PatchRewriteOp = Type.Object(
	{
		action: Type.Literal("patch"),
		name: Type.String(),
		content: Type.String({ description: "Full replacement content" }),
		file_path: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const WriteFileOp = Type.Object(
	{
		action: Type.Literal("write_file"),
		name: Type.String(),
		file_path: Type.String(),
		file_content: Type.String(),
	},
	{ additionalProperties: false },
);

const RemoveFileOp = Type.Object(
	{
		action: Type.Literal("remove_file"),
		name: Type.String(),
		file_path: Type.String(),
	},
	{ additionalProperties: false },
);

const DeleteOp = Type.Object(
	{
		action: Type.Literal("delete"),
		name: Type.String(),
		absorbed_into: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const OpSchema = Type.Union([CreateOp, PatchTargetedOp, PatchRewriteOp, WriteFileOp, RemoveFileOp, DeleteOp]);

// Keep a single root `type: "object"`. Some OpenAI-compatible endpoints — notably
// the OpenCode Go (Zen) API — reject an entire request with HTTP 400 and an empty
// body when a tool's parameter schema has a root-level `anyOf`/`oneOf` instead of a
// top-level object. Nested unions (the OpSchema array items) are accepted.
// normalizeParams() still accepts either `operations` (batch) or a flat `action` op.
export const SKILL_MANAGE_PARAMETERS = Type.Object({
	operations: Type.Optional(Type.Array(OpSchema, { minItems: 1, maxItems: 20 })),
	action: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	content: Type.Optional(Type.String()),
	old_string: Type.Optional(Type.String()),
	new_string: Type.Optional(Type.String()),
	replace_all: Type.Optional(Type.Boolean()),
	file_path: Type.Optional(Type.String()),
	file_content: Type.Optional(Type.String()),
	category: Type.Optional(Type.String()),
	absorbed_into: Type.Optional(Type.String()),
});

export const SKILL_MANAGE_DESCRIPTION =
	"Créer, mettre à jour ou supprimer des skills — ta mémoire procédurale pour les types de tâches récurrentes. " +
	"L'appel est un tableau `operations` (une seule édition = une liste d'un élément) appliqué **atomiquement** : tout échec annule l'ensemble. " +
	"Ops : `create` (SKILL.md complet, doit précéder les autres ops de la même skill), `patch` (correction ciblée `old_string`/`new_string` — préféré ; " +
	"`content` seul REMPLACE tout le fichier, à lire avec `read` avant), `write_file`/`remove_file` (fichiers support), `delete` (op unique). " +
	"Garde les 57 premiers caractères de la description auto-portants : « Use when <déclencheur>. <comportement en une ligne>. » " +
	"Écris des leçons, pas des journaux : règle impérative + pourquoi, sans numéro de PR, sans date, sans narration d'incident, une règle par leçon, " +
	"`references/` nommé par sujet (étendre avant d'ajouter).";

export const SKILL_MANAGE_GUIDELINES = [
	"Après avoir surmonté une erreur non évidente ou découvert une procédure réutilisable, enregistre-la avec `skill_manage` pour que les sessions futures en bénéficient.",
	"Préfère `patch` à une réécriture complète : seules les lignes modifiées voyagent dans l'appel.",
	"Avant de patcher une skill existante, lis son SKILL.md avec `read` : la garde read-before-write refusera sinon.",
	"Ne capture pas les échecs d'environnement, les affirmations négatives sur des outils, ni les échecs non résolus — ils deviennent des contraintes auto-imposées.",
];

function normalizeParams(params: unknown): SkillOp[] | { error: string } {
	if (!params || typeof params !== "object") return { error: "parameters must be an object" };
	const record = params as Record<string, unknown>;
	if (Array.isArray(record.operations)) return record.operations as SkillOp[];
	if (typeof record.action === "string") return [record as SkillOp];
	return { error: "provide `operations` (batch) or a flat legacy op with `action`" };
}

export function skillDirFor(name: string, category?: string): string {
	return category ? join(skillsRoot(), category, name) : join(skillsRoot(), name);
}

interface BatchContext {
	config: ReturnType<typeof loadConfig>;
	options: ExecuteBatchOptions;
	actor: LedgerActor;
	touched: Map<string, true>;
	snapshots: Map<string, { snapshotDir: string; preexisted: boolean; createdFiles: string[] }>;
	snapshotRoot: string;
}

function resolveOpFilePath(skillDir: string, op: SkillOp): string {
	const rel = typeof op.file_path === "string" && op.file_path.trim() !== "" ? op.file_path : "SKILL.md";
	return join(skillDir, rel);
}

function touchKey(name: string, filePath: string): string {
	return `${name}\u0000${filePath}`;
}

function validateBatch(ops: SkillOp[], origin: SkillOrigin): { error?: string; ops?: SkillOp[] } {
	if (ops.length === 0) return { error: "`operations` must not be empty" };
	if (ops.length > 20) return { error: "a batch is limited to 20 operations" };
	const deleteOps = ops.filter((op) => op.action === "delete");
	if (deleteOps.length > 1) return { error: "only one `delete` op is allowed" };
	if (deleteOps.length === 1 && ops.length > 1) return { error: "`delete` must be the single op of its batch" };
	const createSeen = new Set<string>();
	const createIndex = new Map<string, number>();
	for (let index = 0; index < ops.length; index++) {
		const op = ops[index];
		if (typeof op.action !== "string") return { error: `op #${index}: missing \`action\`` };
		const known = ["create", "patch", "write_file", "remove_file", "delete"];
		if (!known.includes(op.action)) return { error: `op #${index}: unknown action "${op.action}"` };
		const nameCheck = validateSkillName(op.name);
		if (!nameCheck.ok) return { error: `op #${index}: ${nameCheck.error}` };
		const shape = opShapeError(op);
		if (shape) return { error: `op #${index}: ${shape}` };
		if (op.action === "create") {
			createSeen.add(op.name as string);
			createIndex.set(op.name as string, index);
			const categoryCheck = validateCategory(op.category);
			if (!categoryCheck.ok) return { error: `op #${index}: ${categoryCheck.error}` };
		}
		if (op.action === "write_file" || op.action === "remove_file") {
			const pathCheck = validateFilePath(op.file_path);
			if (!pathCheck.ok) return { error: `op #${index}: ${pathCheck.error}` };
			if (op.file_path === "SKILL.md") return { error: `op #${index}: use \`create\` or \`patch\` for SKILL.md` };
		}
		if (op.action === "patch" && typeof op.content === "string") {
			const pathCheck = validateFilePath(op.file_path ?? "SKILL.md");
			if (!pathCheck.ok) return { error: `op #${index}: ${pathCheck.error}` };
		}
		if (op.action === "delete" && origin !== "foreground") {
			const { data, unreadable } = readUsageFile();
			const guard = canDeleteAutonomously({
				name: op.name as string,
				entry: data?.skills[op.name as string],
				usageUnreadable: unreadable,
			});
			if (!guard.allowed) return { error: `op #${index}: autonomous delete refused — ${guard.reason}` };
			if (origin === "curator" && (typeof op.absorbed_into !== "string" || op.absorbed_into.trim() === ""))
				return { error: `op #${index}: consolidation delete requires a non-empty \`absorbed_into\`` };
		}
	}
	// A create for a skill must precede its other ops.
	for (let index = 0; index < ops.length; index++) {
		const op = ops[index];
		if (op.action === "create") continue;
		const createdAt = createIndex.get(op.name as string);
		if (createdAt !== undefined && createdAt > index)
			return {
				error: `op #${index}: the \`create\` of "${op.name}" must precede this op (create is at #${createdAt})`,
			};
	}
	return { ops };
}

function checkBlockingLint(content: string, name: string, dirName: string | undefined): LintFinding[] {
	const findings = lintSkill({ name, dirName, raw: content });
	return findings.filter((f) => f.blocking);
}

function rollbackSnapshots(ctx: BatchContext, names: string[]): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	for (const name of names) {
		const snap = ctx.snapshots.get(name);
		if (!snap) continue;
		const skillDir = locateSkillDir(name) ?? skillDirFor(name);
		const broken = `${skillDir}.rollback-broken`;
		try {
			if (dirExists(skillDir)) moveTree(skillDir, broken);
			if (snap.preexisted || snap.createdFiles.length > 0) {
				copyTree(snap.snapshotDir, skillDir);
			} else if (dirExists(broken)) {
				removeTree(broken);
			}
			if (dirExists(broken)) removeTree(broken);
		} catch {
			// Restoration failed: put the half-applied state back in place (worse to lose it),
			// keep the snapshot directory for manual recovery.
			try {
				if (!dirExists(skillDir) && dirExists(broken)) moveTree(broken, skillDir);
			} catch {
				errors.push(`rollback failed and restore-in-place failed for "${name}"`);
				continue;
			}
			errors.push(`rollback failed for "${name}" — snapshots kept at ${ctx.snapshotRoot}`);
		}
	}
	return { ok: errors.length === 0, errors };
}

async function applyOp(op: SkillOp, ctx: BatchContext): Promise<OperationResult> {
	const action = op.action;
	const name = op.name as string;
	const dirName = name;
	switch (action) {
		case "create": {
			const existingDir = locateSkillDir(name);
			if (existingDir && fileExists(join(existingDir, "SKILL.md")))
				return {
					success: false,
					action,
					name,
					message: `skill "${name}" already exists — use \`patch\` (read it first) instead of \`create\``,
				};
			const skillDir = existingDir ?? skillDirFor(name, typeof op.category === "string" ? op.category : undefined);
			const validation = validateSkillContent(op.content, { creating: true, expectedName: dirName });
			if (!validation.ok) return { success: false, action, name, message: validation.error };
			const blocking = checkBlockingLint(op.content as string, name, dirName);
			if (blocking.length > 0 && ctx.config.lint.blockOnInjection)
				return {
					success: false,
					action,
					name,
					message: `blocked: ${blocking.map((f) => `${f.rule}: ${f.message}`).join("; ")}`,
				};
			await atomicWriteFile(join(skillDir, "SKILL.md"), op.content as string, { exclusive: true }).catch((error) => {
				if (fileExists(join(skillDir, "SKILL.md"))) {
					throw new Error(`skill "${name}" already exists — use \`patch\` (read it first) instead of \`create\``);
				}
				throw error;
			});
			const findings = ctx.config.lint.enabled
				? lintSkill({ name, dirName, raw: op.content as string, files: ["SKILL.md"] })
				: [];
			return {
				success: true,
				action,
				name,
				path: join(skillDir, "SKILL.md"),
				message: `Created skill "${name}"`,
				lint_warnings: findings.length > 0 ? findings : undefined,
			};
		}
		case "patch": {
			const skillDir = locateSkillDir(name);
			if (!skillDir) return { success: false, action, name, message: `skill "${name}" not found` };
			const filePath = resolveOpFilePath(skillDir, op);
			const relPath = typeof op.file_path === "string" && op.file_path !== "" ? op.file_path : "SKILL.md";
			if (!fileExists(filePath))
				return { success: false, action, name, message: `${relPath} not found in "${name}"` };
			const markError = readMarkError(filePath);
			if (markError) return { success: false, action, name, message: markError };
			const before = readTextFile(filePath);
			let after: string;
			if (typeof op.content === "string") {
				if (relPath === "SKILL.md") {
					const validation = validateSkillContent(op.content, { creating: false, expectedName: dirName });
					if (!validation.ok) return { success: false, action, name, message: validation.error };
				}
				after = op.content;
			} else {
				const oldString = op.old_string as string;
				const newString = op.new_string as string;
				const index = before.indexOf(oldString);
				if (index < 0) {
					const preview = before.split("\n").slice(0, 8).join("\n");
					return {
						success: false,
						action,
						name,
						message:
							`old_string not found in ${relPath}. Read the file and retry with the exact text; ` +
							`do NOT fall back to a full rewrite.\n--- first lines ---\n${preview}`,
					};
				}
				after =
					op.replace_all === true
						? before.split(oldString).join(newString)
						: before.slice(0, index) + newString + before.slice(index + oldString.length);
			}
			const blocking = checkBlockingLint(after, name, dirName);
			if (blocking.length > 0 && ctx.config.lint.blockOnInjection)
				return {
					success: false,
					action,
					name,
					message: `blocked: ${blocking.map((f) => `${f.rule}: ${f.message}`).join("; ")}`,
				};
			await atomicWriteFile(filePath, after);
			const findings = ctx.config.lint.enabled
				? introducedFindings(
						lintSkill({ name, dirName, raw: before }),
						lintSkill({ name, dirName, raw: after, files: listFilesRelative(skillDir) }),
					)
				: [];
			return {
				success: true,
				action,
				name,
				path: filePath,
				message: `Updated ${relPath} in "${name}"`,
				lint_warnings: findings.length > 0 ? findings : undefined,
			};
		}
		case "write_file": {
			const skillDir = locateSkillDir(name);
			if (!skillDir) return { success: false, action, name, message: `skill "${name}" not found` };
			const contentCheck = validateFileContent(op.file_content);
			if (!contentCheck.ok) return { success: false, action, name, message: contentCheck.error };
			const filePath = join(skillDir, op.file_path as string);
			if (fileExists(filePath)) {
				const markError = readMarkError(filePath);
				if (markError) return { success: false, action, name, message: markError };
			}
			await atomicWriteFile(filePath, op.file_content as string);
			return { success: true, action, name, path: filePath, message: `Wrote ${op.file_path} in "${name}"` };
		}
		case "remove_file": {
			const skillDir = locateSkillDir(name);
			if (!skillDir) return { success: false, action, name, message: `skill "${name}" not found` };
			const filePath = join(skillDir, op.file_path as string);
			if (!fileExists(filePath))
				return { success: false, action, name, message: `${op.file_path} not found in "${name}"` };
			const markError = readMarkError(filePath);
			if (markError) return { success: false, action, name, message: markError };
			unlinkSync(filePath);
			return { success: true, action, name, path: filePath, message: `Removed ${op.file_path} from "${name}"` };
		}
		case "delete": {
			const skillDir = locateSkillDir(name);
			if (!skillDir || !fileExists(join(skillDir, "SKILL.md")))
				return { success: false, action, name, message: `skill "${name}" not found` };
			const markError = readMarkError(join(skillDir, "SKILL.md"));
			if (markError) return { success: false, action, name, message: markError };
			const archiveRoot = archiveDir();
			let target = join(archiveRoot, name);
			if (dirExists(target)) target = join(archiveRoot, `${name}-${Date.now().toString(36)}`);
			moveTree(skillDir, target);
			return {
				success: true,
				action,
				name,
				path: target,
				message: `Archived skill "${name}" (reversible — nothing is permanently deleted)`,
			};
		}
		default:
			return { success: false, action, name, message: `unsupported action "${action}"` };
	}
}

export async function executeBatch(rawOps: SkillOp[], options: ExecuteBatchOptions): Promise<BatchOutcome> {
	const config = loadConfig();
	const normalized = validateBatch(rawOps, options.origin);
	if (normalized.error || !normalized.ops)
		return { success: false, operations_applied: 0, results: [], error: normalized.error };
	const ops = normalized.ops;
	// Clobber guard: a destructive op on a file already touched by this batch is refused.
	const touched = new Map<string, true>();
	for (let index = 0; index < ops.length; index++) {
		const op = ops[index];
		const name = op.name as string;
		const destructive =
			op.action === "create" ||
			op.action === "write_file" ||
			op.action === "remove_file" ||
			(op.action === "patch" && typeof op.content === "string");
		if (op.action === "delete") continue;
		const rel = typeof op.file_path === "string" && op.file_path !== "" ? op.file_path : "SKILL.md";
		const key = touchKey(name, rel);
		if (destructive && touched.has(key))
			return {
				success: false,
				operations_applied: 0,
				results: [],
				error: `op #${index}: ${op.action} on ${rel} of "${name}" would overwrite work already done by an earlier op of this batch`,
			};
		if (destructive) touched.set(key, true);
	}
	// Gate: when writeApproval is on, the WHOLE batch is staged as one record.
	if (config.writeApproval && !options.bypassGate && !allowWriteOverride()) return stageBatch(ops, options.origin);
	const names = [...new Set(ops.map((op) => op.name as string))];
	const release = await acquireLocks(names.map((name) => `skill:${name}`));
	try {
		const snapshotRoot = mkdtempSync(join(tmpdir(), "skill-snapshot-"));
		const ctx: BatchContext = {
			config,
			options,
			actor:
				options.actor ??
				(options.origin === "background_review"
					? "background_review"
					: options.origin === "curator"
						? "curator"
						: "foreground"),
			touched,
			snapshots: new Map(),
			snapshotRoot,
		};
		for (const name of names) {
			const skillDir = locateSkillDir(name);
			const snapDir = join(snapshotRoot, name);
			if (skillDir && dirExists(skillDir)) {
				try {
					copyTree(skillDir, snapDir);
					ctx.snapshots.set(name, { snapshotDir: snapDir, preexisted: true, createdFiles: [] });
				} catch {
					ctx.snapshots.set(name, { snapshotDir: snapDir, preexisted: dirExists(skillDir), createdFiles: [] });
				}
			} else {
				ctx.snapshots.set(name, { snapshotDir: snapDir, preexisted: false, createdFiles: [] });
			}
		}
		const results: OperationResult[] = [];
		for (let index = 0; index < ops.length; index++) {
			const op = ops[index];
			let result: OperationResult;
			try {
				result = await applyOp(op, ctx);
			} catch (error) {
				result = {
					success: false,
					action: op.action,
					name: typeof op.name === "string" ? op.name : "?",
					message: String(error instanceof Error ? error.message : error),
				};
			}
			results.push(result);
			if (!result.success) {
				const rollback = rollbackSnapshots(ctx, names);
				const message = rollback.ok ? result.message : `${result.message} (WARNING: ${rollback.errors.join("; ")})`;
				return {
					success: false,
					operations_applied: 0,
					failed_index: index,
					completed_before_failure: index,
					results: results.map((entry, entryIndex) =>
						entryIndex === index ? { ...entry, message } : { ...entry, success: false },
					),
					error: message,
				};
			}
			// Ledger line per applied mutation.
			const skillDir = locateSkillDir(op.name as string);
			if (skillDir && config.ledger.enabled) {
				const refs = captureFiles(skillDir);
				try {
					await appendEntry({
						id: newEntryId(),
						ts: new Date().toISOString(),
						actor: ctx.actor,
						session_id: options.sessionId,
						action: op.action,
						name: op.name as string,
						before: [],
						after: refs,
						evidence: op.action === "delete" ? { archived: true, absorbed_into: op.absorbed_into } : undefined,
					});
				} catch {
					// Ledger is an audit trail, not a gate — a failed append must not undo a good write.
				}
			}
		}
		// Usage bookkeeping: a foreground create marks "learn"; review/curator creates mark "agent".
		try {
			const { data } = readUsageFile();
			if (data) {
				let changed = false;
				for (const op of ops) {
					const name = op.name as string;
					const seeded = seedIfMissing(data, name, new Date());
					if (seeded.seeded) changed = true;
					if (
						op.action === "create" &&
						options.origin !== "foreground" &&
						isCuratorManaged(data.skills[name]) === false
					) {
						data.skills[name].created_by = "agent";
						changed = true;
					}
				}
				if (changed) await saveUsage(data);
			}
		} catch {
			// Usage bookkeeping is best-effort; the write already succeeded.
		}
		removeTree(snapshotRoot);
		return { success: true, operations_applied: results.length, results };
	} finally {
		release();
	}
}

function renderBatch(outcome: BatchOutcome): string {
	if (outcome.staged) {
		return `Staged batch ${outcome.staged_id} for approval — nothing was applied yet. Review with /skill-system pending.`;
	}
	if (!outcome.success) {
		const failed =
			outcome.failed_index !== undefined ? ` (failed at op #${outcome.failed_index}; nothing was applied)` : "";
		const lines = outcome.results.map((r) => `- ${r.name || "?"}: ${r.message}`);
		return `skill_manage error${failed}: ${outcome.error ?? "batch failed"}\n${lines.join("\n")}`.trim();
	}
	const lines = outcome.results.map((result) => {
		const warning = result.lint_warnings?.length
			? ` [lint: ${result.lint_warnings.map((f) => f.rule).join(", ")}]`
			: "";
		return `${result.message}${warning}`;
	});
	return lines.join("\n");
}

export function registerSkillManageTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "skill_manage",
		label: "Skill Manage",
		description: SKILL_MANAGE_DESCRIPTION,
		permissionTier: "write",
		executionMode: "sequential",
		promptSnippet: "Create, update, or delete reusable skills (atomic batch).",
		promptGuidelines: SKILL_MANAGE_GUIDELINES,
		parameters: SKILL_MANAGE_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!loadConfig().enabled) {
				return {
					content: [{ type: "text", text: "skill_manage is disabled (skillSystem.enabled=false)" }],
					details: { success: false, operations_applied: 0, results: [] },
					isError: true,
				};
			}
			if (isReviewFork()) resetReadMarks();
			const ops = normalizeParams(params);
			if ("error" in ops) {
				return {
					content: [{ type: "text", text: `skill_manage error: ${ops.error}` }],
					details: { success: false, operations_applied: 0, results: [] },
					isError: true,
				};
			}
			const origin: SkillOrigin = isReviewFork() ? "background_review" : "foreground";
			const outcome = await executeBatch(ops, { origin });
			return {
				content: [{ type: "text", text: renderBatch(outcome) }],
				details: outcome,
				isError: !outcome.success,
			};
		},
	});
}
