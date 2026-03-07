/**
 * Orchestrator Extension - Full-cycle project planning and execution
 *
 * WORKFLOW (single command):
 *   /plan <description> → LLM analyzes → orchestrate tool → spec + todo → auto-execute → progress
 *   Everything happens in one shot. No manual steps.
 *
 * Commands:
 *   /plan   — Full workflow: plan + execute with sub-agents
 *   /run    — Re-execute an existing plan (e.g. after fixes)
 *   /plans  — List plans and their execution status
 *
 * Sub-agent execution:
 * Each task spawns a separate `phi` CLI process with:
 * - Its own system prompt (from the agent .md file)
 * - Its own model (from routing.json)
 * - Its own context (isolated, no shared history)
 * - Its own tool access (read, write, edit, bash, etc.)
 * Results are collected into progress.md and reported to the user.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "phi-code";
import { writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────

interface TaskDef {
	title: string;
	description: string;
	agent?: string;
	priority?: string;
	dependencies?: number[];
	subtasks?: string[];
}

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
					if (agents.has(name)) continue;

					try {
						const content = readFileSync(join(dir, file), "utf-8");
						const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
						if (!fmMatch) continue;

						const frontmatter = fmMatch[1];
						const body = fmMatch[2].trim();
						const desc = frontmatter.match(/description:\s*(.+)/)?.[1] || "";
						const tools = frontmatter.match(/tools:\s*(.+)/)?.[1] || "";

						agents.set(name, { name, description: desc, tools, systemPrompt: body });
					} catch { /* skip */ }
				}
			} catch { /* skip */ }
		}

		return agents;
	}

	function resolveAgentModel(agentType: string): string | null {
		const routingPath = join(homedir(), ".phi", "agent", "routing.json");
		try {
			const config = JSON.parse(readFileSync(routingPath, "utf-8"));
			for (const [_cat, route] of Object.entries(config.routes || {})) {
				const r = route as any;
				if (r.agent === agentType) return r.preferredModel || null;
			}
			// Map agent type to route category
			const categoryMap: Record<string, string> = {
				code: "code", explore: "explore", plan: "plan",
				test: "test", review: "review", debug: "debug",
			};
			const category = categoryMap[agentType];
			if (category && config.routes?.[category]) {
				return config.routes[category].preferredModel || null;
			}
			return config.default?.model || null;
		} catch {
			return null;
		}
	}

	function findPhiBinary(): string {
		const bundledCli = join(__dirname, "..", "..", "..", "dist", "cli.js");
		if (existsSync(bundledCli)) return bundledCli;
		try {
			const which = require("child_process").execSync("which phi 2>/dev/null", { encoding: "utf-8" }).trim();
			if (which) return which;
		} catch { /* not in PATH */ }
		return "npx";
	}

	// ─── Sub-Agent Execution ─────────────────────────────────────────

	function executeTask(
		task: TaskDef,
		agentDefs: Map<string, AgentDef>,
		cwd: string,
		timeoutMs: number = 300000,
	): Promise<TaskResult> {
		return new Promise((resolve) => {
			const agentType = task.agent || "code";
			const agentDef = agentDefs.get(agentType);
			const model = resolveAgentModel(agentType);
			const phiBin = findPhiBinary();
			const startTime = Date.now();

			let taskPrompt = `Task: ${task.title}\n\n${task.description}`;
			if (task.subtasks && task.subtasks.length > 0) {
				taskPrompt += "\n\nSub-tasks:\n" + task.subtasks.map((st, i) => `${i + 1}. ${st}`).join("\n");
			}
			taskPrompt += "\n\nComplete this task. Be thorough and precise. Report what you did.";

			const args: string[] = [];
			if (phiBin === "npx") args.push("@phi-code-admin/phi-code");

			args.push("--print");
			if (model && model !== "default") args.push("--model", model);
			if (agentDef?.systemPrompt) args.push("--system-prompt", agentDef.systemPrompt);
			args.push("--no-save");
			args.push(taskPrompt);

			const cmd = phiBin === "npx" ? "npx" : "node";
			const cmdArgs = phiBin === "npx" ? args : [phiBin, ...args];

			execFile(cmd, cmdArgs, {
				cwd,
				timeout: timeoutMs,
				maxBuffer: 10 * 1024 * 1024,
				env: { ...process.env },
			}, (error, stdout, stderr) => {
				const durationMs = Date.now() - startTime;
				if (error) {
					resolve({
						taskIndex: 0, title: task.title, agent: agentType,
						status: "error", output: `Error: ${error.message}\n${stderr || ""}`.trim(), durationMs,
					});
				} else {
					resolve({
						taskIndex: 0, title: task.title, agent: agentType,
						status: "success", output: stdout.trim(), durationMs,
					});
				}
			});
		});
	}

	// ─── Execute All Tasks ───────────────────────────────────────────

	async function executePlan(
		tasks: TaskDef[],
		todoFile: string,
		notify: (msg: string, type: "info" | "error" | "warning") => void,
	): Promise<{ results: TaskResult[]; progressFile: string }> {
		const agentDefs = loadAgentDefs();
		const progressFile = todoFile.replace("todo-", "progress-");
		const progressPath = join(plansDir, progressFile);
		let progress = `# Progress: ${todoFile}\n\n`;
		progress += `**Started:** ${new Date().toLocaleString()}\n`;
		progress += `**Tasks:** ${tasks.length}\n\n`;
		await writeFile(progressPath, progress, "utf-8");

		notify(`🚀 Executing ${tasks.length} tasks with sub-agents...`, "info");

		const results: TaskResult[] = [];

		for (let i = 0; i < tasks.length; i++) {
			const task = tasks[i];
			const agentType = task.agent || "code";
			notify(`⏳ Task ${i + 1}/${tasks.length}: **${task.title}** [${agentType}]`, "info");

			const result = await executeTask(task, agentDefs, process.cwd());
			result.taskIndex = i + 1;
			results.push(result);

			const icon = result.status === "success" ? "✅" : "❌";
			const duration = (result.durationMs / 1000).toFixed(1);
			const outputPreview = result.output.length > 500 ? result.output.slice(0, 500) + "..." : result.output;
			notify(`${icon} Task ${i + 1}: **${task.title}** (${duration}s)\n${outputPreview}`,
				result.status === "success" ? "info" : "error");

			progress += `## Task ${i + 1}: ${task.title}\n\n`;
			progress += `- **Status:** ${result.status}\n`;
			progress += `- **Agent:** ${result.agent}\n`;
			progress += `- **Duration:** ${duration}s\n`;
			progress += `- **Output:**\n\n\`\`\`\n${result.output.slice(0, 3000)}\n\`\`\`\n\n`;
			await writeFile(progressPath, progress, "utf-8");
		}

		const succeeded = results.filter(r => r.status === "success").length;
		const failed = results.filter(r => r.status === "error").length;
		const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0);

		progress += `---\n\n## Summary\n\n`;
		progress += `- **Completed:** ${new Date().toLocaleString()}\n`;
		progress += `- **Succeeded:** ${succeeded}/${results.length}\n`;
		progress += `- **Failed:** ${failed}\n`;
		progress += `- **Total time:** ${(totalTime / 1000).toFixed(1)}s\n`;
		await writeFile(progressPath, progress, "utf-8");

		notify(
			`\n🏁 **Execution complete!**\n` +
			`✅ ${succeeded}/${results.length} succeeded | ❌ ${failed} failed | ⏱️ ${(totalTime / 1000).toFixed(1)}s\n` +
			`Progress: \`${progressFile}\``,
			failed === 0 ? "info" : "warning"
		);

		return { results, progressFile };
	}

	// ─── Generate Plan Files ─────────────────────────────────────────

	function generateSpec(p: {
		title: string; description: string; goals: string[]; requirements: string[];
		architecture?: string[]; constraints?: string[]; successCriteria?: string[]; tasks: TaskDef[];
	}): string {
		let spec = `# ${p.title}\n\n`;
		spec += `**Created:** ${new Date().toLocaleString()}\n\n`;
		spec += `## Description\n\n${p.description}\n\n`;
		spec += `## Goals\n\n`;
		p.goals.forEach((g, i) => { spec += `${i + 1}. ${g}\n`; });
		spec += "\n## Requirements\n\n";
		p.requirements.forEach(r => { spec += `- ${r}\n`; });
		spec += "\n";
		if (p.architecture?.length) {
			spec += `## Architecture\n\n`;
			p.architecture.forEach(a => { spec += `- ${a}\n`; });
			spec += "\n";
		}
		if (p.constraints?.length) {
			spec += `## Constraints\n\n`;
			p.constraints.forEach(c => { spec += `- ${c}\n`; });
			spec += "\n";
		}
		if (p.successCriteria?.length) {
			spec += `## Success Criteria\n\n`;
			p.successCriteria.forEach(s => { spec += `- [ ] ${s}\n`; });
			spec += "\n";
		}
		spec += `## Task Overview\n\n| # | Task | Agent | Priority | Dependencies |\n|---|------|-------|----------|-------------|\n`;
		p.tasks.forEach((t, i) => {
			const deps = t.dependencies?.map(d => `#${d}`).join(", ") || "—";
			spec += `| ${i + 1} | ${t.title} | ${t.agent || "code"} | ${t.priority || "medium"} | ${deps} |\n`;
		});
		spec += `\n---\n*Generated by Phi Code Orchestrator*\n`;
		return spec;
	}

	function generateTodo(title: string, tasks: TaskDef[]): string {
		let todo = `# TODO: ${title}\n\n`;
		todo += `**Created:** ${new Date().toLocaleString()}\n`;
		todo += `**Tasks:** ${tasks.length}\n**Status:** executing\n\n`;
		tasks.forEach((t, i) => {
			const agentTag = t.agent ? ` [${t.agent}]` : "";
			const prioTag = t.priority === "high" ? " 🔴" : t.priority === "low" ? " 🟢" : " 🟡";
			const depsTag = t.dependencies?.length ? ` (after #${t.dependencies.join(", #")})` : "";
			todo += `## Task ${i + 1}: ${t.title}${prioTag}${agentTag}${depsTag}\n\n- [ ] ${t.description}\n`;
			if (t.subtasks) t.subtasks.forEach(st => { todo += `  - [ ] ${st}\n`; });
			todo += "\n";
		});
		todo += `---\n\n## Progress\n\n- Total: ${tasks.length} tasks\n`;
		todo += `- High priority: ${tasks.filter(t => t.priority === "high").length}\n`;
		todo += `- Agents: ${[...new Set(tasks.map(t => t.agent || "code"))].join(", ")}\n`;
		return todo;
	}

	// ─── Orchestrate Tool (plan + auto-execute) ──────────────────────

	pi.registerTool({
		name: "orchestrate",
		label: "Project Orchestrator",
		description: "Create a project plan AND automatically execute all tasks with sub-agents. Each agent gets its own isolated context, model, and system prompt. Call this after analyzing the user's project request.",
		promptSnippet: "Plan + execute projects. Creates spec/todo, then runs each task with an isolated sub-agent.",
		promptGuidelines: [
			"When asked to plan or build a project: analyze the request, then call orchestrate. It will plan AND execute automatically.",
			"Break tasks into small, actionable items. Each task is executed by an isolated sub-agent.",
			"Assign agent types: 'explore' (analysis), 'plan' (design), 'code' (implementation), 'test' (validation), 'review' (quality).",
			"Order tasks by dependency. Sub-agents execute sequentially, respecting the order.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Project title" }),
			description: Type.String({ description: "Full project description with context" }),
			goals: Type.Array(Type.String(), { description: "List of project goals" }),
			requirements: Type.Array(Type.String(), { description: "Technical and functional requirements" }),
			architecture: Type.Optional(Type.Array(Type.String(), { description: "Architecture decisions" })),
			tasks: Type.Array(
				Type.Object({
					title: Type.String({ description: "Task title" }),
					description: Type.String({ description: "Detailed task description with enough context for the agent to work independently" }),
					agent: Type.Optional(Type.String({ description: "Agent type: explore, plan, code, test, or review" })),
					priority: Type.Optional(Type.String({ description: "high, medium, or low" })),
					dependencies: Type.Optional(Type.Array(Type.Number(), { description: "IDs of prerequisite tasks (1-indexed)" })),
					subtasks: Type.Optional(Type.Array(Type.String(), { description: "Sub-task descriptions" })),
				}),
				{ description: "Ordered list of tasks to execute" }
			),
			constraints: Type.Optional(Type.Array(Type.String(), { description: "Project constraints" })),
			successCriteria: Type.Optional(Type.Array(Type.String(), { description: "Completion criteria" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as {
				title: string; description: string; goals: string[]; requirements: string[];
				architecture?: string[]; tasks: TaskDef[]; constraints?: string[]; successCriteria?: string[];
			};

			try {
				await ensurePlansDir();
				const ts = timestamp();
				const specFile = `spec-${ts}.md`;
				const todoFile = `todo-${ts}.md`;

				// Generate and write plan files
				const spec = generateSpec(p);
				const todo = generateTodo(p.title, p.tasks);
				await writeFile(join(plansDir, specFile), spec, "utf-8");
				await writeFile(join(plansDir, todoFile), todo, "utf-8");

				// Notify plan created
				const notify = (msg: string, type: "info" | "error" | "warning") => {
					// Use onUpdate for streaming progress to the user
					if (_onUpdate) {
						_onUpdate({ content: [{ type: "text", text: msg }] });
					}
				};

				notify(`📋 Plan created: **${p.title}** (${p.tasks.length} tasks)\nNow executing with sub-agents...`, "info");

				// Auto-execute all tasks
				const { results, progressFile } = await executePlan(p.tasks, todoFile, notify);

				const succeeded = results.filter(r => r.status === "success").length;
				const failed = results.filter(r => r.status === "error").length;
				const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0);

				const summary = `**🏁 Project "${p.title}" — Complete!**

**Plan files:** \`${specFile}\`, \`${todoFile}\`
**Progress:** \`${progressFile}\`

**Results:**
- ✅ Succeeded: ${succeeded}/${results.length}
- ❌ Failed: ${failed}
- ⏱️ Total time: ${(totalTime / 1000).toFixed(1)}s

**Task details:**
${results.map(r => {
	const icon = r.status === "success" ? "✅" : "❌";
	return `${icon} Task ${r.taskIndex}: ${r.title} [${r.agent}] (${(r.durationMs / 1000).toFixed(1)}s)`;
}).join("\n")}

All files in \`.phi/plans/\``;

				return {
					content: [{ type: "text", text: summary }],
					details: {
						specFile, todoFile, progressFile,
						taskCount: p.tasks.length, succeeded, failed,
						totalTimeMs: totalTime, title: p.title,
					},
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Orchestration failed: ${error}` }],
					details: { error: String(error) },
				};
			}
		},
	});

	// ─── /plan Command — Full workflow ───────────────────────────────

	pi.registerCommand("plan", {
		description: "Plan AND execute a project: creates spec + todo, then runs each task with isolated sub-agents",
		handler: async (args, ctx) => {
			const description = args.trim();

			if (!description) {
				ctx.ui.notify(`**Usage:** \`/plan <project description>\`

**Full workflow in one command:**
1. LLM analyzes your description
2. Creates spec.md + todo.md
3. Executes each task with an isolated sub-agent
4. Each agent has its own context, model, and system prompt
5. Results saved to progress.md

**Examples:**
  /plan Build a REST API for user authentication with JWT
  /plan Add test coverage to the payment module
  /plan Refactor the frontend to use TypeScript

**Other commands:**
  /run   — Re-execute an existing plan
  /plans — List all plans and status`, "info");
				return;
			}

			ctx.sendUserMessage(
				`Analyze this project request and execute it using the orchestrate tool.
The orchestrate tool will create the plan AND execute all tasks automatically with sub-agents.

Project: ${description}

Instructions:
- Identify goals, requirements, architecture decisions
- Break into small tasks (each executable by one sub-agent independently)
- Each task description must contain FULL context — the sub-agent has NO shared history
- Assign agent types: explore (analysis), plan (design), code (implementation), test (validation), review (quality)
- Set priorities and dependencies
- Call the orchestrate tool — it handles everything from there`
			);
		},
	});

	// ─── /run Command — Re-execute existing plan ─────────────────────

	pi.registerCommand("run", {
		description: "Re-execute an existing plan's tasks with sub-agents",
		handler: async (args, ctx) => {
			if (!existsSync(plansDir)) {
				ctx.ui.notify("No plans found. Use `/plan <description>` to create and execute one.", "warning");
				return;
			}

			const files = (await readdir(plansDir)).sort().reverse();
			const todoFiles = files.filter(f => f.startsWith("todo-") && f.endsWith(".md"));

			if (todoFiles.length === 0) {
				ctx.ui.notify("No todo files found. Use `/plan <description>` first.", "warning");
				return;
			}

			const todoFile = todoFiles[0];
			const todoContent = await readFile(join(plansDir, todoFile), "utf-8");

			// Parse tasks
			const tasks: TaskDef[] = [];
			const sections = todoContent.split(/## Task \d+:/);
			for (let i = 1; i < sections.length; i++) {
				const section = sections[i];
				const titleMatch = section.match(/^(.+?)(?:\s*🔴|\s*🟡|\s*🟢)/);
				const agentMatch = section.match(/\[(\w+)\]/);
				const descMatch = section.match(/- \[ \] (.+)/);
				const subtasks: string[] = [];
				const stMatches = section.matchAll(/  - \[ \] (.+)/g);
				for (const m of stMatches) subtasks.push(m[1]);

				if (titleMatch && descMatch) {
					tasks.push({
						title: titleMatch[1].trim(),
						agent: agentMatch?.[1] || "code",
						description: descMatch[1].trim(),
						subtasks: subtasks.length > 0 ? subtasks : undefined,
					});
				}
			}

			if (tasks.length === 0) {
				ctx.ui.notify("Could not parse tasks from todo file.", "error");
				return;
			}

			const confirmed = await ctx.ui.confirm(
				"Re-execute Plan",
				`${tasks.length} tasks found in \`${todoFile}\`.\nEach will spawn an isolated sub-agent.\n\nProceed?`
			);
			if (!confirmed) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}

			await executePlan(tasks, todoFile, (msg, type) => ctx.ui.notify(msg, type));
		},
	});

	// ─── /plans Command ──────────────────────────────────────────────

	pi.registerCommand("plans", {
		description: "List all project plans and their execution status",
		handler: async (_args, ctx) => {
			if (!existsSync(plansDir)) {
				ctx.ui.notify("No plans yet. Use `/plan <description>` to create and execute one.", "info");
				return;
			}

			const files = await readdir(plansDir);
			const specs = files.filter(f => f.startsWith("spec-") && f.endsWith(".md")).sort().reverse();

			if (specs.length === 0) {
				ctx.ui.notify("No plans found.", "info");
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

			output += `_Commands: \`/plan\` (create+execute), \`/run\` (re-execute), \`read .phi/plans/<file>\` (view)_`;
			ctx.ui.notify(output, "info");
		},
	});
}
