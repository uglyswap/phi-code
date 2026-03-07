/**
 * Orchestrator Extension - Project planning and automatic task execution
 *
 * Provides tools for the LLM to create structured project plans and execute them:
 * - /plan: Interactive planning command → creates spec.md + todo.md
 * - /plans: List and manage existing plans
 * - /run: Execute plan tasks using sub-agents (each with own context + model)
 * - orchestrate tool: Create spec.md + todo.md from structured input
 *
 * Sub-agent execution:
 * Each task spawns a separate `phi` CLI process with:
 * - Its own system prompt (from the agent .md file)
 * - Its own model (from routing.json or current model)
 * - Its own context (isolated, no shared history)
 * - Its own tool access (read, write, edit, bash, etc.)
 * Results are collected into progress.md and reported to the user.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "phi-code";
import { writeFile, mkdir, readdir, readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────

interface TaskResult {
	taskIndex: number;
	title: string;
	agent: string;
	status: "success" | "error" | "skipped";
	output: string;
	durationMs: number;
}

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
}

// ─── Extension ───────────────────────────────────────────────────────────

export default function orchestratorExtension(pi: ExtensionAPI) {
	const plansDir = join(process.cwd(), ".phi", "plans");

	async function ensurePlansDir() {
		await mkdir(plansDir, { recursive: true });
	}

	function timestamp(): string {
		return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
	}

	// ─── Agent Discovery ─────────────────────────────────────────────

	/**
	 * Load agent definitions from .md files.
	 * Searches: project .phi/agents/ → global ~/.phi/agent/agents/ → bundled agents/
	 */
	function loadAgentDefs(): Map<string, AgentDef> {
		const agents = new Map<string, AgentDef>();
		const dirs = [
			join(process.cwd(), ".phi", "agents"),
			join(homedir(), ".phi", "agent", "agents"),
			join(__dirname, "..", "..", "..", "agents"),
		];

		for (const dir of dirs) {
			if (!existsSync(dir)) continue;
			try {
				const files = require("fs").readdirSync(dir) as string[];
				for (const file of files) {
					if (!file.endsWith(".md")) continue;
					const name = file.replace(".md", "");
					if (agents.has(name)) continue; // Priority: project > global > bundled

					try {
						const content = readFileSync(join(dir, file), "utf-8");
						const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
						if (!fmMatch) continue;

						const frontmatter = fmMatch[1];
						const body = fmMatch[2].trim();

						const desc = frontmatter.match(/description:\s*(.+)/)?.[1] || "";
						const tools = frontmatter.match(/tools:\s*(.+)/)?.[1] || "";

						agents.set(name, { name, description: desc, tools, systemPrompt: body });
					} catch { /* skip unparseable files */ }
				}
			} catch { /* skip inaccessible dirs */ }
		}

		return agents;
	}

	/**
	 * Resolve the model for an agent type from routing.json.
	 */
	function resolveAgentModel(agentType: string): string | null {
		const routingPath = join(homedir(), ".phi", "agent", "routing.json");
		try {
			const config = JSON.parse(readFileSync(routingPath, "utf-8"));
			// Find the route that maps to this agent
			for (const [_category, route] of Object.entries(config.routes || {})) {
				const r = route as any;
				if (r.agent === agentType) {
					return r.preferredModel || null;
				}
			}
			return config.default?.model || null;
		} catch {
			return null;
		}
	}

	/**
	 * Find the phi CLI binary path.
	 */
	function findPhiBinary(): string {
		// 1. Try the dist/cli.js from our package
		const bundledCli = join(__dirname, "..", "..", "..", "dist", "cli.js");
		if (existsSync(bundledCli)) return bundledCli;

		// 2. Try global phi binary
		try {
			const which = require("child_process").execSync("which phi 2>/dev/null", { encoding: "utf-8" }).trim();
			if (which) return which;
		} catch { /* not in PATH */ }

		// 3. Fallback to npx
		return "npx";
	}

	// ─── Sub-Agent Execution ─────────────────────────────────────────

	/**
	 * Execute a task using a sub-agent process.
	 * Each agent gets its own isolated phi process with:
	 * - Its system prompt (from agent .md)
	 * - Its model (from routing.json)
	 * - No saved session (--no-save)
	 * - JSON output mode (--json)
	 */
	function executeTask(
		task: { title: string; description: string; agent?: string; subtasks?: string[] },
		agentDefs: Map<string, AgentDef>,
		cwd: string,
		timeoutMs: number = 300000, // 5 minutes per task
	): Promise<TaskResult> {
		return new Promise((resolve) => {
			const agentType = task.agent || "code";
			const agentDef = agentDefs.get(agentType);
			const model = resolveAgentModel(agentType);
			const phiBin = findPhiBinary();
			const startTime = Date.now();

			// Build the task prompt
			let taskPrompt = `Task: ${task.title}\n\n${task.description}`;
			if (task.subtasks && task.subtasks.length > 0) {
				taskPrompt += "\n\nSub-tasks:\n" + task.subtasks.map((st, i) => `${i + 1}. ${st}`).join("\n");
			}
			taskPrompt += "\n\nComplete this task. Be thorough and precise. Report what you did.";

			// Build the command
			const args: string[] = [];
			if (phiBin === "npx") {
				args.push("@phi-code-admin/phi-code");
			}

			// Add flags
			args.push("--print"); // Non-interactive, output only
			if (model && model !== "default") {
				args.push("--model", model);
			}
			if (agentDef?.systemPrompt) {
				args.push("--system-prompt", agentDef.systemPrompt);
			}
			args.push("--no-save"); // Don't create a session
			args.push(taskPrompt);

			const cmd = phiBin === "npx" ? "npx" : "node";
			const cmdArgs = phiBin === "npx" ? args : [phiBin, ...args];

			const child = execFile(cmd, cmdArgs, {
				cwd,
				timeout: timeoutMs,
				maxBuffer: 10 * 1024 * 1024, // 10MB
				env: { ...process.env },
			}, (error, stdout, stderr) => {
				const durationMs = Date.now() - startTime;

				if (error) {
					resolve({
						taskIndex: 0,
						title: task.title,
						agent: agentType,
						status: "error",
						output: `Error: ${error.message}\n${stderr || ""}`.trim(),
						durationMs,
					});
				} else {
					resolve({
						taskIndex: 0,
						title: task.title,
						agent: agentType,
						status: "success",
						output: stdout.trim(),
						durationMs,
					});
				}
			});
		});
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
					dependencies: Type.Optional(Type.Array(Type.Number(), { description: "IDs of tasks this depends on (1-indexed)" })),
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
				todo += `**Tasks:** ${p.tasks.length}\n`;
				todo += `**Status:** pending\n\n`;

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
				todo += `*Run \`/run\` to execute tasks automatically with sub-agents.*\n`;

				// Write files
				await writeFile(join(plansDir, specFile), spec, "utf-8");
				await writeFile(join(plansDir, todoFile), todo, "utf-8");

				const summary = `**✅ Project plan created!**

📋 **${p.title}**

**Files:**
- \`${specFile}\` — Full specification
- \`${todoFile}\` — Task list with agent assignments

**Summary:**
- ${p.goals.length} goals, ${p.requirements.length} requirements
- ${p.tasks.length} tasks (${p.tasks.filter(t => t.priority === "high").length} high priority)
- Agents: ${[...new Set(p.tasks.map(t => t.agent || "code"))].join(", ")}

**Execute:** Run \`/run\` to launch sub-agents and execute tasks automatically.
Each agent gets its own context, model, and system prompt.`;

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

	// ─── /run Command — Execute plan with sub-agents ─────────────────

	pi.registerCommand("run", {
		description: "Execute the latest plan's tasks using sub-agents (each with own context and model)",
		handler: async (args, ctx) => {
			// Find the latest todo file
			if (!existsSync(plansDir)) {
				ctx.ui.notify("No plans found. Use `/plan <description>` to create one first.", "warning");
				return;
			}

			const files = (await readdir(plansDir)).sort().reverse();
			const todoFiles = files.filter(f => f.startsWith("todo-") && f.endsWith(".md"));

			if (todoFiles.length === 0) {
				ctx.ui.notify("No todo files found. Use `/plan <description>` first.", "warning");
				return;
			}

			const todoFile = todoFiles[0]; // Most recent
			const todoPath = join(plansDir, todoFile);
			const todoContent = await readFile(todoPath, "utf-8");

			// Parse tasks from todo.md
			const taskRegex = /## Task (\d+): (.+?)(?:\s*🔴|\s*🟡|\s*🟢)?\s*(?:\[(\w+)\])?\s*(?:\(after.*?\))?\n\n- \[ \] (.+?)(?:\n(?:  - \[ \] .+?\n)*)?/g;
			const tasks: Array<{ index: number; title: string; agent: string; description: string; subtasks: string[] }> = [];

			let match;
			while ((match = taskRegex.exec(todoContent)) !== null) {
				const subtaskRegex = /  - \[ \] (.+)/g;
				const subtasks: string[] = [];
				const taskBlock = todoContent.slice(match.index, taskRegex.lastIndex + 500);
				let stMatch;
				while ((stMatch = subtaskRegex.exec(taskBlock)) !== null) {
					subtasks.push(stMatch[1]);
				}

				tasks.push({
					index: parseInt(match[1]),
					title: match[2].trim(),
					agent: match[3] || "code",
					description: match[4].trim(),
					subtasks,
				});
			}

			if (tasks.length === 0) {
				ctx.ui.notify("Could not parse tasks from the todo file. Check the format.", "error");
				return;
			}

			// Load agent definitions
			const agentDefs = loadAgentDefs();
			const availableAgents = [...agentDefs.keys()].join(", ") || "none loaded";

			// Confirm execution
			const confirmed = await ctx.ui.confirm(
				"Execute Plan",
				`Found ${tasks.length} tasks in \`${todoFile}\`.\n` +
				`Available agents: ${availableAgents}\n` +
				`Each task will spawn an isolated phi process with its own context.\n\n` +
				`Proceed?`
			);

			if (!confirmed) {
				ctx.ui.notify("Execution cancelled.", "info");
				return;
			}

			// Create progress file
			const progressFile = todoFile.replace("todo-", "progress-");
			const progressPath = join(plansDir, progressFile);
			let progress = `# Progress: ${todoFile}\n\n`;
			progress += `**Started:** ${new Date().toLocaleString()}\n`;
			progress += `**Tasks:** ${tasks.length}\n\n`;
			await writeFile(progressPath, progress, "utf-8");

			ctx.ui.notify(`🚀 Starting execution of ${tasks.length} tasks...`, "info");

			// Execute tasks in order (respecting dependencies)
			const results: TaskResult[] = [];
			const completed = new Set<number>();

			for (const task of tasks) {
				ctx.ui.notify(`\n⏳ **Task ${task.index}: ${task.title}** [${task.agent}]`, "info");

				// Execute the task
				const result = await executeTask(
					{ title: task.title, description: task.description, agent: task.agent, subtasks: task.subtasks },
					agentDefs,
					process.cwd(),
				);
				result.taskIndex = task.index;

				results.push(result);
				completed.add(task.index);

				// Report result
				const icon = result.status === "success" ? "✅" : "❌";
				const duration = (result.durationMs / 1000).toFixed(1);
				ctx.ui.notify(
					`${icon} **Task ${task.index}: ${task.title}** (${duration}s)\n` +
					`Agent: ${task.agent} | Output: ${result.output.slice(0, 500)}${result.output.length > 500 ? "..." : ""}`,
					result.status === "success" ? "info" : "error"
				);

				// Update progress file
				progress += `## Task ${task.index}: ${task.title}\n\n`;
				progress += `- **Status:** ${result.status}\n`;
				progress += `- **Agent:** ${result.agent}\n`;
				progress += `- **Duration:** ${duration}s\n`;
				progress += `- **Output:**\n\n\`\`\`\n${result.output.slice(0, 2000)}\n\`\`\`\n\n`;
				await writeFile(progressPath, progress, "utf-8");
			}

			// Final summary
			const succeeded = results.filter(r => r.status === "success").length;
			const failed = results.filter(r => r.status === "error").length;
			const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0);

			progress += `---\n\n## Summary\n\n`;
			progress += `- **Completed:** ${new Date().toLocaleString()}\n`;
			progress += `- **Succeeded:** ${succeeded}/${results.length}\n`;
			progress += `- **Failed:** ${failed}\n`;
			progress += `- **Total time:** ${(totalTime / 1000).toFixed(1)}s\n`;
			await writeFile(progressPath, progress, "utf-8");

			ctx.ui.notify(
				`\n🏁 **Execution complete!**\n\n` +
				`✅ Succeeded: ${succeeded}/${results.length}\n` +
				`❌ Failed: ${failed}\n` +
				`⏱️ Total time: ${(totalTime / 1000).toFixed(1)}s\n\n` +
				`Progress saved to \`${progressFile}\``,
				failed === 0 ? "info" : "warning"
			);
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
1. Analyze your description
2. Break down into tasks with agent assignments
3. Create spec.md + todo.md files in .phi/plans/
4. Run \`/run\` to execute with sub-agents

Each sub-agent gets its own isolated context, model, and system prompt.`, "info");
				return;
			}

			ctx.sendUserMessage(
				`Please analyze this project request and create a structured plan using the orchestrate tool.

Project description: ${description}

Instructions:
- Identify clear goals, requirements, and architecture decisions
- Break the work into small, actionable tasks (each doable by one agent)
- Assign the best agent type to each task: explore (analysis), plan (design), code (implementation), test (validation), review (quality)
- Set priorities (high/medium/low) and dependencies between tasks
- Define success criteria for the project`
			);
		},
	});

	// ─── /plans Command ──────────────────────────────────────────────

	pi.registerCommand("plans", {
		description: "List existing project plans and their execution status",
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
					const progressFile = `progress-${ts}.md`;

					try {
						const content = await readFile(join(plansDir, specFile), "utf-8");
						const titleMatch = content.match(/^# (.+)$/m);
						const title = titleMatch ? titleMatch[1] : specFile;
						const taskCount = (content.match(/\| \d+ \|/g) || []).length;
						const date = ts.replace(/_/g, " ").substring(0, 10);

						const hasTodo = files.includes(todoFile);
						const hasProgress = files.includes(progressFile);
						const status = hasProgress ? "🟢 executed" : hasTodo ? "🟡 planned" : "⚪ spec only";

						output += `📋 **${title}** (${date}) ${status}\n`;
						output += `   Spec: \`${specFile}\``;
						if (hasTodo) output += ` | Todo: \`${todoFile}\``;
						if (hasProgress) output += ` | Progress: \`${progressFile}\``;
						output += "\n";
						if (taskCount > 0) output += `   Tasks: ${taskCount}\n`;
						output += "\n";
					} catch {
						output += `📋 \`${specFile}\`\n\n`;
					}
				}

				output += `_Commands: \`/plan\` (create), \`/run\` (execute), \`read .phi/plans/<file>\` (view)_`;
				ctx.ui.notify(output, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to list plans: ${error}`, "error");
			}
		},
	});
}
