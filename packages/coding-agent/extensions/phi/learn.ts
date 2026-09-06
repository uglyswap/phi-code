/**
 * Learn Extension - auto-apprentissage (omp-style)
 *
 * Registers the `learn` tool: capture a durable lesson. Facts go to sigma-memory
 * (memory_write); procedures can be promoted to a managed skill written to
 * ~/.phi/agent/managed-skills/<name>/SKILL.md, which the skill scanner picks up
 * (lowest precedence source).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "phi-code";

const MANAGED_SKILLS_DIR = join(homedir(), ".phi", "agent", "managed-skills");

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "learn",
		label: "Learn",
		permissionTier: "write",
		description:
			"Capture a durable lesson learned during this session. Set promote_to_skill=true when the lesson is a reusable procedure (it becomes a managed skill auto-loaded in future sessions). Facts and preferences stay in memory instead (use memory_write).",
		promptGuidelines: [
			"After overcoming a non-obvious error or discovering a reusable procedure, call learn so future sessions benefit.",
			"Promote to skill only reusable procedures (trigger conditions + numbered steps + pitfalls), not one-off facts.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Short lesson/skill name (will be slugified)" }),
			lesson: Type.String({ description: "The lesson: what happened, what to do differently, steps if procedural" }),
			promote_to_skill: Type.Optional(
				Type.Boolean({ description: "Write as a managed skill in ~/.phi/agent/managed-skills/ (default false)" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const p = params as { name: string; lesson: string; promote_to_skill?: boolean };
			try {
				if (p.promote_to_skill) {
					const slug = slugify(p.name);
					if (!slug) {
						return {
							content: [{ type: "text", text: "learn error: name produced an empty slug" }],
							details: { promoted: false },
							isError: true,
						};
					}
					const dir = join(MANAGED_SKILLS_DIR, slug);
					mkdirSync(dir, { recursive: true });
					const description = p.lesson.split("\n").find((l) => l.trim())?.slice(0, 200) ?? p.name;
					writeFileSync(
						join(dir, "SKILL.md"),
						`---\nname: ${slug}\ndescription: ${description.replace(/"/g, "'")}\n---\n\n# ${p.name}\n\n${p.lesson}\n`,
					);
					return {
						content: [
							{
								type: "text",
								text: `Skill learned: **${slug}** written to ${dir}/SKILL.md. It loads from the next session (or after /reload).`,
							},
						],
						details: { promoted: true, slug, path: dir },
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Lesson noted: "${p.name}". For durable storage across sessions, also call memory_write, or set promote_to_skill=true for reusable procedures.`,
						},
					],
					details: { promoted: false },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `learn error: ${error}` }],
					details: { promoted: false },
					isError: true,
				};
			}
		},
	});
}
