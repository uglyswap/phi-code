/**
 * Phi Init Extension - legacy `/phi-init` entry point.
 *
 * Since 0.97.0 the provider/model wizard lives in ONE place: /setup
 * (setup.ts, backed by the shared providers/catalog.ts). The wizard that used
 * to live here was a drifting near-copy of it, with its own models.json
 * reader that silently wiped a commented config. /phi-init now only:
 *   1. scaffolds the ~/.phi structure (dirs, bundled agents, AGENTS.md template)
 *   2. delegates to the exact same wizard as /setup
 *
 * /plan-models (lightweight per-role reassignment without provider probing)
 * stays here, but reuses the shared assignment/routing helpers from setup.ts
 * instead of maintaining a second copy of the picker and routing writer.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "phi-code";
import {
	buildRoutingConfig,
	configureAssignments,
	ORCHESTRATION_ROLES,
	runSetupWizard,
	writeRoutingConfig,
} from "./setup.js";

const phiDir = join(homedir(), ".phi");
const agentDir = join(phiDir, "agent");
const agentsDir = join(agentDir, "agents");
const memoryDir = join(phiDir, "memory");

async function ensureDirs(): Promise<void> {
	for (const dir of [
		agentDir,
		agentsDir,
		join(agentDir, "skills"),
		join(agentDir, "extensions"),
		memoryDir,
		join(memoryDir, "ontology"),
	]) {
		await mkdir(dir, { recursive: true });
	}
}

async function copyBundledAgents(): Promise<void> {
	const bundledDir = resolve(join(__dirname, "..", "..", "..", "agents"));
	if (!existsSync(bundledDir)) return;
	try {
		const files = await readdir(bundledDir);
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			const dest = join(agentsDir, file);
			if (!existsSync(dest)) {
				await copyFile(join(bundledDir, file), dest);
			}
		}
	} catch {
		// bundled dir not available
	}
}

async function createAgentsTemplate(): Promise<void> {
	const agentsMdPath = join(memoryDir, "AGENTS.md");
	if (existsSync(agentsMdPath)) return;
	await writeFile(
		agentsMdPath,
		`# AGENTS.md — Persistent Instructions

This file is loaded at the start of every session. Use it to store:
- Project conventions and rules
- Recurring instructions
- Important context the agent should always know

## Project

- Name: (your project name)
- Language: TypeScript
- Framework: (your framework)

## Conventions

- (your coding conventions)
- (your naming rules)
- (your commit format)

## Important Notes

- (anything the agent should always remember)

---

_Edit this file to customize Phi Code's behavior for your project._
`,
		"utf-8",
	);
}

// ─── Extension ───────────────────────────────────────────────────────────

export default function initExtension(pi: ExtensionAPI) {
	pi.registerCommand("phi-init", {
		description: "Initialize Phi Code: scaffold ~/.phi, then run the /setup wizard (legacy alias)",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.notify("Scaffolding ~/.phi (directories, bundled agents, AGENTS.md template)...", "info");
				await ensureDirs();
				await copyBundledAgents();
				await createAgentsTemplate();
				ctx.ui.notify(
					"`/phi-init` delegates to the `/setup` wizard (one wizard, no drift). " +
						"Use `/plan-models` afterwards to reassign per-role models without re-probing providers.",
					"info",
				);
				await runSetupWizard(ctx.ui);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Setup failed: ${message}`, "error");
			}
		},
	});

	// ─── /plan-models : lightweight per-role model reconfiguration ─────
	// Standalone alternative to re-running the full wizard. Sources the model
	// list from the already-loaded model registry (no provider probing), shows
	// the current routing, and reuses the shared picker + routing writer.
	pi.registerCommand("plan-models", {
		description: "Reconfigure the per-role models used by /plan (provider-qualified, cross-provider)",
		handler: async (_args, ctx) => {
			try {
				const registryModels: Array<{ provider?: string; id?: string }> = ctx.modelRegistry?.getAvailable?.() || [];
				const available: Array<{ ref: string; display: string }> = [];
				const seen = new Set<string>();
				for (const m of registryModels) {
					if (!m?.provider || !m?.id) continue;
					// Provider-qualified reference ("provider/id") so the same model id
					// offered by several providers stays distinct at selection time.
					const ref = `${m.provider}/${m.id}`;
					if (seen.has(ref)) continue;
					seen.add(ref);
					available.push({ ref, display: `${m.id} [${m.provider}]` });
				}
				if (available.length === 0) {
					ctx.ui.notify("No configured models found. Add a provider via `/setup` first.", "warning");
					return;
				}

				// Show the current per-role assignment as the starting point.
				let current: { routes?: Record<string, { preferredModel?: string; fallback?: string }> } = {};
				try {
					current = JSON.parse(await readFile(join(agentDir, "routing.json"), "utf-8"));
				} catch {
					/* no routing config yet */
				}
				const roleKeys = [
					...ORCHESTRATION_ROLES.map((r) => ({ key: r.key, label: r.label })),
					{ key: "debug", label: "Debug" },
				];
				const currentLines = roleKeys
					.map(({ key, label }) => {
						const route = current.routes?.[key];
						return `  ${label}: ${route?.preferredModel || "default"} (fallback: ${route?.fallback || "default"})`;
					})
					.join("\n");
				ctx.ui.notify(`Current /plan models:\n${currentLines}\n`, "info");

				const { defaultModel, orchestration } = await configureAssignments(ctx.ui, available);
				await ensureDirs();
				const routing = buildRoutingConfig(defaultModel, orchestration);
				const routingPath = await writeRoutingConfig(routing);
				ctx.ui.notify(`Updated \`${routingPath}\`. \`/plan\` will use these per-role models.`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/plan-models failed: ${message}`, "error");
			}
		},
	});
}
