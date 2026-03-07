/**
 * Orchestrator Extension - Project planning and task management
 *
 * Provides tools for the LLM to create structured project plans:
 * - /plan: Interactive planning command
 * - /plans: List and manage existing plans
 * - orchestrate tool: Create spec.md + todo.md from structured input
 *
 * Architecture:
 * The LLM analyzes the user's request (using prompt-architect skill patterns
 * if available), then calls the orchestrate tool with structured data.
 * The tool writes files to disk. The LLM does the thinking, the tool does the I/O.
 *
 * Integration with Prompt Architect skill:
 * When the prompt-architect skill is loaded, the LLM uses its patterns
 * (ROLE/CONTEXT/TASK/FORMAT/CONSTRAINTS) to structure the spec.
 * The skill-loader extension handles this automatically.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "phi-code";
import { writeFile, mkdir, readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export default function orchestratorExtension(pi: ExtensionAPI) {
	const plansDir = join(process.cwd(), ".phi", "plans");

	async function ensurePlansDir() {
		await mkdir(plansDir, { recursive: true });
	}

	function timestamp(): string {
		return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
	}

	// ─── Orchestrate Tool ────────────────────────────────────────────

	pi.registerTool({
		name: "orchestrate",
		label: "Project Orchestrator",
		description: "Create structured project plan files (spec.md + todo.md) from analyzed project requirements. Call this AFTER you have analyzed the user's request and structured it into goals, requirements, architecture decisions, and tasks.",
		promptSnippet: "Create spec.md + todo.md project plans. Use prompt-architect patterns to structure specs before calling.",
		promptGuidelines: [
			"When asked to plan a project: first analyze the request thoroughly, then call orchestrate with structured data.",
			"Use the prompt-architect skill patterns (ROLE/CONTEXT/TASK/FORMAT/CONSTRAINTS) when structuring specifications.",
			"Break tasks into small, actionable items. Each task should be completable by a single sub-agent.",
			"Assign agent types to tasks: 'explore' for analysis, 'plan' for design, 'code' for implementation, 'test' for validation, 'review' for quality.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Project title" }),
			description: Type.String({ description: "Full project description with context" }),
			goals: Type.Array(Type.String(), { description: "List of project goals" }),
			requirements: Type.Array(Type.String(), { description: "Technical and functional requirements" }),
			architecture: Type.Optional(Type.Array(Type.String(), { description: "Architecture decisions and tech stack" })),
			tasks: Type.Array(
				Type.Object({
					title: Type.String({ description: "Task title" }),
					description: Type.String({ description: "Detailed task description" }),
					agent: Type.Optional(Type.String({ description: "Recommended agent: explore, plan, code, test, or review" })),
					priority: Type.Optional(Type.String({ description: "high, medium, or low" })),
					dependencies: Type.Optional(Type.Array(Type.Number(), { description: "IDs of tasks this depends on" })),
					subtasks: Type.Optional(Type.Array(Type.String(), { description: "Sub-task descriptions" })),
				}),
				{ description: "Ordered list of tasks" }
			),
			constraints: Type.Optional(Type.Array(Type.String(), { description: "Project constraints and limitations" })),
			successCriteria: Type.Optional(Type.Array(Type.String(), { description: "How to verify the project is done" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const p = params as {
				title: string;
				description: string;
				goals: string[];
				requirements: string[];
				architecture?: string[];
				tasks: Array<{
					title: string;
					description: string;
					agent?: string;
					priority?: string;
					dependencies?: number[];
					subtasks?: string[];
				}>;
				constraints?: string[];
				successCriteria?: string[];
			};

			try {
				await ensurePlansDir();
				const ts = timestamp();
				const specFile = `spec-${ts}.md`;
				const todoFile = `todo-${ts}.md`;

				// ─── Generate spec.md ─────────────────────────────────
				let spec = `# ${p.title}\n\n`;
				spec += `**Created:** ${new Date().toLocaleString()}\n\n`;
				spec += `## Description\n\n${p.description}\n\n`;

				spec += `## Goals\n\n`;
				p.goals.forEach((g, i) => { spec += `${i + 1}. ${g}\n`; });
				spec += "\n";

				spec += `## Requirements\n\n`;
				p.requirements.forEach(r => { spec += `- ${r}\n`; });
				spec += "\n";

				if (p.architecture && p.architecture.length > 0) {
					spec += `## Architecture\n\n`;
					p.architecture.forEach(a => { spec += `- ${a}\n`; });
					spec += "\n";
				}

				if (p.constraints && p.constraints.length > 0) {
					spec += `## Constraints\n\n`;
					p.constraints.forEach(c => { spec += `- ${c}\n`; });
					spec += "\n";
				}

				if (p.successCriteria && p.successCriteria.length > 0) {
					spec += `## Success Criteria\n\n`;
					p.successCriteria.forEach(s => { spec += `- [ ] ${s}\n`; });
					spec += "\n";
				}

				spec += `## Task Overview\n\n`;
				spec += `| # | Task | Agent | Priority | Dependencies |\n`;
				spec += `|---|------|-------|----------|-------------|\n`;
				p.tasks.forEach((t, i) => {
					const deps = t.dependencies?.map(d => `#${d}`).join(", ") || "—";
					spec += `| ${i + 1} | ${t.title} | ${t.agent || "code"} | ${t.priority || "medium"} | ${deps} |\n`;
				});
				spec += "\n";

				spec += `---\n*Generated by Phi Code Orchestrator*\n`;

				// ─── Generate todo.md ─────────────────────────────────
				let todo = `# TODO: ${p.title}\n\n`;
				todo += `**Created:** ${new Date().toLocaleString()}\n`;
				todo += `**Tasks:** ${p.tasks.length}\n\n`;

				p.tasks.forEach((t, i) => {
					const agentTag = t.agent ? ` [${t.agent}]` : "";
					const prioTag = t.priority === "high" ? " 🔴" : t.priority === "low" ? " 🟢" : " 🟡";
					const depsTag = t.dependencies?.length ? ` (after #${t.dependencies.join(", #")})` : "";

					todo += `## Task ${i + 1}: ${t.title}${prioTag}${agentTag}${depsTag}\n\n`;
					todo += `- [ ] ${t.description}\n`;

					if (t.subtasks) {
						t.subtasks.forEach(st => {
							todo += `  - [ ] ${st}\n`;
						});
					}
					todo += "\n";
				});

				todo += `---\n\n## Progress\n\n`;
				todo += `- Total: ${p.tasks.length} tasks\n`;
				todo += `- High priority: ${p.tasks.filter(t => t.priority === "high").length}\n`;
				todo += `- Agents needed: ${[...new Set(p.tasks.map(t => t.agent || "code"))].join(", ")}\n\n`;
				todo += `*Update [ ] to [x] when tasks are completed.*\n`;

				// Write files
				await writeFile(join(plansDir, specFile), spec, "utf-8");
				await writeFile(join(plansDir, todoFile), todo, "utf-8");

				const summary = `**✅ Project plan created!**

📋 **${p.title}**

**Files:**
- \`${specFile}\` — Full specification (goals, requirements, architecture, constraints)
- \`${todoFile}\` — Actionable task list with priorities and agent assignments

**Summary:**
- ${p.goals.length} goals
- ${p.requirements.length} requirements
- ${p.tasks.length} tasks (${p.tasks.filter(t => t.priority === "high").length} high priority)
- Agents: ${[...new Set(p.tasks.map(t => t.agent || "code"))].join(", ")}

**Next steps:**
1. Review the spec and todo files
2. Start with high-priority tasks
3. Follow dependency order
4. Mark tasks [x] when done

Files saved in \`.phi/plans/\``;

				return {
					content: [{ type: "text", text: summary }],
					details: { specFile, todoFile, taskCount: p.tasks.length, title: p.title },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Orchestration failed: ${error}` }],
					details: { error: String(error) },
				};
			}
		},
	});

	// ─── /plan Command ───────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Create a structured project plan (the LLM analyzes your description, then creates spec + todo files)",
		handler: async (args, ctx) => {
			const description = args.trim();

			if (!description) {
				ctx.ui.notify(`**Usage:** \`/plan <project description>\`

**Examples:**
  /plan Build a REST API for user authentication with JWT tokens
  /plan Migrate the frontend from React to Next.js App Router
  /plan Add comprehensive test coverage to the payment module

The LLM will:
1. Analyze your description using prompt-architect patterns
2. Identify goals, requirements, architecture decisions
3. Break down into tasks with agent assignments and priorities
4. Create spec.md + todo.md files in .phi/plans/

💡 The more detail you provide, the better the plan.`, "info");
				return;
			}

			// Send as user message to trigger the LLM to analyze and call orchestrate
			ctx.sendUserMessage(
				`Please analyze this project request and create a structured plan using the orchestrate tool.

Project description: ${description}

Instructions:
- Identify clear goals, requirements, and architecture decisions
- Break the work into small, actionable tasks (each doable by one agent)
- Assign the best agent type to each task: explore (analysis), plan (design), code (implementation), test (validation), review (quality)
- Set priorities (high/medium/low) and dependencies between tasks
- Define success criteria for the project
- If the prompt-architect skill is available, use its ROLE/CONTEXT/TASK/FORMAT patterns to structure the specification`
			);
		},
	});

	// ─── /plans Command ──────────────────────────────────────────────

	pi.registerCommand("plans", {
		description: "List existing project plans",
		handler: async (_args, ctx) => {
			try {
				if (!existsSync(plansDir)) {
					ctx.ui.notify("No plans yet. Use `/plan <description>` to create one.", "info");
					return;
				}

				const files = await readdir(plansDir);
				const specs = files.filter(f => f.startsWith("spec-") && f.endsWith(".md")).sort().reverse();

				if (specs.length === 0) {
					ctx.ui.notify("No plans found. Use `/plan <description>` to create one.", "info");
					return;
				}

				let output = `📁 **Project Plans** (${specs.length})\n\n`;

				for (const specFile of specs) {
					const ts = specFile.replace("spec-", "").replace(".md", "");
					const todoFile = `todo-${ts}.md`;

					try {
						const content = await readFile(join(plansDir, specFile), "utf-8");
						const titleMatch = content.match(/^# (.+)$/m);
						const title = titleMatch ? titleMatch[1] : specFile;
						const taskCount = (content.match(/\| \d+ \|/g) || []).length;
						const date = ts.replace(/_/g, " ").substring(0, 10);

						const hasTodo = files.includes(todoFile);

						output += `📋 **${title}** (${date})\n`;
						output += `   Spec: \`${specFile}\`${hasTodo ? ` | Todo: \`${todoFile}\`` : ""}\n`;
						if (taskCount > 0) output += `   Tasks: ${taskCount}\n`;
						output += "\n";
					} catch {
						output += `📋 \`${specFile}\`\n\n`;
					}
				}

				output += `_Use \`read .phi/plans/<file>\` to view a plan._`;
				ctx.ui.notify(output, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to list plans: ${error}`, "error");
			}
		},
	});
}
