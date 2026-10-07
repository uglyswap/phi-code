/**
 * skill-system — skill authoring, provenance, review and curation for phi.
 *
 * Wires: `skill_manage` (C1), `/learn` + bundled-learn observation (C3), the
 * background review (C4), the curator (C5), the staging gate (C6), the linter
 * (C7), backups (C8), the project-skill scan (C9) and `/skill-system` (C10).
 * State lives under `<agentDir>/skills/.state/` — invisible to the core and
 * sigma-skills loaders (dot prefix).
 */

import type { ExtensionAPI } from "phi-code";
import { debugEnabled, isDisabledByEnv, isReviewFork, loadConfig } from "./config.ts";
import { loadCuratorState, observedSkillNames, runCurator, saveCuratorState, shouldRunCurator } from "./curator.ts";
import { observeLearnResult, registerLearnCommand } from "./learn-command.ts";
import { skillsRoot } from "./paths.ts";
import { noteToolCall } from "./readmarks.ts";
import { cancelReview, maybeScheduleReview, noteInterrupted, noteToolIteration, resetInterrupted } from "./review.ts";
import { scanProjectSkills } from "./scan.ts";
import { registerSkillSystemCommands } from "./skills-commands.ts";
import { cleanupStaleTmpFiles } from "./store.ts";
import { executeBatch, registerSkillManageTool } from "./tool.ts";
import { markUsed, readUsageFile, saveUsage, seedIfMissing } from "./usage.ts";

function log(message: string): void {
	if (!debugEnabled()) return;
	try {
		process.stderr.write(`[skill-system] ${message}\n`);
	} catch {
		// Logging must never take the extension down.
	}
}

/** Names invoked as `/skill:<name>` in a text (input or system prompt). */
function invokedSkillNames(text: string): string[] {
	const names = new Set<string>();
	for (const match of text.matchAll(/\/skill:([a-z0-9][a-z0-9._-]*)/g)) names.add(match[1]);
	return [...names];
}

export default function skillSystemExtension(pi: ExtensionAPI): void {
	if (isDisabledByEnv()) return;
	registerSkillManageTool(pi);
	registerSkillSystemCommands(pi, { apply: executeBatch });
	registerLearnCommand(pi);

	pi.on("session_start", async (_event, ctx) => {
		const config = loadConfig();
		if (!config.enabled) return;
		try {
			const removed = cleanupStaleTmpFiles(skillsRoot());
			if (removed > 0) log(`cleaned ${removed} stale tmp file(s)`);
			// Command-name collision check: a future phi version could take our names,
			// and a duplicate registration only shows up as `/name:2`.
			try {
				const collisions = pi
					.getCommands()
					.map((command) => command.name)
					.filter((name) => /^(skill-system|learn):\d+$/.test(name));
				if (collisions.length > 0) {
					ctx.ui.notify(
						`skill-system: command name collision detected (${collisions.join(", ")}) — another extension registered the same name`,
						"warning",
					);
				}
			} catch {
				// getCommands may be unavailable in some runtimes — not fatal.
			}
			// Seed the usage registry so a freshly seen skill is never aged out.
			const { data } = readUsageFile();
			if (data) {
				let changed = false;
				for (const name of observedSkillNames()) {
					if (seedIfMissing(data, name, new Date()).seeded) changed = true;
				}
				if (changed) await saveUsage(data);
			}
			// Scan project skills (untrusted: they come from the opened repo).
			const scanned = scanProjectSkills(ctx.cwd, config.security.quarantineProjectSkills);
			const blocked = scanned.filter((result) => result.verdict === "blocked");
			if (blocked.length > 0) {
				ctx.ui.notify(
					`skill-system: ${blocked.length} project skill(s) flagged by the security scan` +
						(blocked.some((result) => result.quarantined) ? " — quarantined" : ""),
					"warning",
				);
			}
			// Curator: on session start, never during a turn.
			const state = loadCuratorState(new Date());
			const due = shouldRunCurator(state, config.curator, new Date());
			if (due.run) {
				if (due.reason === "first-run") {
					await runCurator({});
				} else {
					const summary = await runCurator({});
					log(`curator: ${JSON.stringify(summary)}`);
				}
			}
		} catch (error) {
			log(`session_start failed: ${String(error)}`);
		}
	});

	// Usage: `/skill:<name>` invocations count as uses; activity resets the idle clock.
	pi.on("input", async (event) => {
		const config = loadConfig();
		if (!config.enabled) return;
		try {
			const names = invokedSkillNames(event.text);
			const { data } = readUsageFile();
			if (data && names.length > 0) {
				let changed = false;
				for (const name of names) {
					if (data.skills[name]) {
						markUsed(data, name, new Date());
						changed = true;
					}
				}
				if (changed) await saveUsage(data);
			}
			const state = loadCuratorState(new Date());
			state.last_activity_at = new Date().toISOString();
			await saveCuratorState(state);
		} catch (error) {
			log(`input bookkeeping failed: ${String(error)}`);
		}
	});

	// Cross-check: skills actually invoked in the prompt (e.g. after replay).
	pi.on("before_agent_start", async (event) => {
		if (isReviewFork()) return;
		try {
			const names = invokedSkillNames(event.systemPrompt);
			if (names.length === 0) return;
			const { data } = readUsageFile();
			if (!data) return;
			let changed = false;
			for (const name of names) {
				if (data.skills[name]) {
					markUsed(data, name, new Date());
					changed = true;
				}
			}
			if (changed) await saveUsage(data);
		} catch (error) {
			log(`usage cross-check failed: ${String(error)}`);
		}
	});

	pi.on("agent_start", async () => {
		resetInterrupted();
	});

	pi.on("tool_call", async (event) => {
		try {
			noteToolCall(event);
		} catch {
			// Read-mark bookkeeping must never block a tool call.
		}
	});

	pi.on("tool_result", async (event) => {
		try {
			return observeLearnResult(event);
		} catch (error) {
			log(`learn observation failed: ${String(error)}`);
			return undefined;
		}
	});

	pi.on("tool_execution_end", async () => {
		noteToolIteration();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const config = loadConfig();
		if (!config.enabled) return;
		if (ctx.signal?.aborted) {
			noteInterrupted();
			return;
		}
		try {
			await maybeScheduleReview({
				branch: ctx.sessionManager.getBranch(),
				hasUI: ctx.hasUI,
				notify: (message, level) => ctx.ui.notify(message, level ?? "info"),
			});
		} catch (error) {
			log(`review scheduling failed: ${String(error)}`);
		}
		if (config.curator.minIdleHours === 0) {
			try {
				const state = loadCuratorState(new Date());
				if (shouldRunCurator(state, config.curator, new Date()).run) await runCurator({});
			} catch (error) {
				log(`idle curator failed: ${String(error)}`);
			}
		}
	});

	pi.on("session_shutdown", async () => {
		await cancelReview();
	});
}
