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
		sharedContext: {
			projectTitle: string;
			projectDescription: string;
			specSummary: string;
			completedTasks: Array<{ index: number; title: string; agent: string; output: string }>;
		},
		timeoutMs: number = 300000,
	): Promise<TaskResult> {
		return new Promise((resolve) => {
			const agentType = task.agent || "code";
			const agentDef = agentDefs.get(agentType);
			const model = resolveAgentModel(agentType);
			const phiBin = findPhiBinary();
			const startTime = Date.now();

			// Build prompt with shared context
			let taskPrompt = "";

			// Inject shared project context (lightweight, always included)
			taskPrompt += `# Project Context\n\n`;
			taskPrompt += `**Project:** ${sharedContext.projectTitle}\n`;
			taskPrompt += `**Description:** ${sharedContext.projectDescription}\n\n`;

			if (sharedContext.specSummary) {
				taskPrompt += `## Specification Summary\n${sharedContext.specSummary}\n\n`;
			}

			// Inject results from dependency tasks (only the ones this task depends on)
			const deps = task.dependencies || [];
			if (deps.length > 0) {
				const depResults = sharedContext.completedTasks.filter(ct => deps.includes(ct.index));
				if (depResults.length > 0) {
					taskPrompt += `## Previous Task Results (your dependencies)\n\n`;
					for (const dep of depResults) {
						const truncatedOutput = dep.output.length > 1500 ? dep.output.slice(0, 1500) + "\n...(truncated)" : dep.output;
						taskPrompt += `### Task ${dep.index}: ${dep.title} [${dep.agent}]\n\`\`\`\n${truncatedOutput}\n\`\`\`\n\n`;
					}
				}
			}

			// The actual task
			taskPrompt += `---\n\n# Your Task\n\n**${task.title}**\n\n${task.description}`;
			if (task.subtasks && task.subtasks.length > 0) {
				taskPrompt += "\n\n## Sub-tasks\n" + task.subtasks.map((st, i) => `${i + 1}. ${st}`).join("\n");
			}
			taskPrompt += `\n\n---\n\n## Instructions\n`;
			taskPrompt += `- You are an isolated agent with your own context. Work independently.\n`;
			taskPrompt += `- Use the project context and dependency results above to inform your work.\n`;
			taskPrompt += `- Follow the output format defined in your system prompt.\n`;
			taskPrompt += `- Be precise. Reference specific file paths and line numbers.\n`;
			taskPrompt += `- Report exactly what you did, what worked, and what didn't.\n`;

			const args: string[] = [];
			if (phiBin === "npx") args.push("@phi-code-admin/phi-code");

			args.push("--print");
			if (model && model !== "default") args.push("--model", model);
			if (agentDef?.systemPrompt) args.push("--system-prompt", agentDef.systemPrompt);
			args.push("--no-session");
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

	// ─── Execute All Tasks (parallel with dependency resolution) ─────

	async function executePlan(
		tasks: TaskDef[],
		todoFile: string,
		notify: (msg: string, type: "info" | "error" | "warning") => void,
		projectContext?: { title: string; description: string; specSummary: string },
	): Promise<{ results: TaskResult[]; progressFile: string }> {
		const agentDefs = loadAgentDefs();
		const progressFile = todoFile.replace("todo-", "progress-");
		const progressPath = join(plansDir, progressFile);
		let progress = `# Progress: ${todoFile}\n\n`;
		progress += `**Started:** ${new Date().toLocaleString()}\n`;
		progress += `**Tasks:** ${tasks.length}\n**Mode:** parallel (dependency-aware, shared context)\n\n`;
		await writeFile(progressPath, progress, "utf-8");

		// Shared context for sub-agents
		const sharedContext = {
			projectTitle: projectContext?.title || "Project",
			projectDescription: projectContext?.description || "",
			specSummary: projectContext?.specSummary || "",
			completedTasks: [] as Array<{ index: number; title: string; agent: string; output: string }>,
		};

		// Build dependency graph
		const completed = new Set<number>();
		const failed = new Set<number>();
		const results: TaskResult[] = [];

		// Check which tasks can run (all dependencies completed successfully)
		function getReadyTasks(): number[] {
			const ready: number[] = [];
			for (let i = 0; i < tasks.length; i++) {
				const taskNum = i + 1;
				if (completed.has(taskNum) || failed.has(taskNum)) continue;

				const deps = tasks[i].dependencies || [];
				const allDepsMet = deps.every(d => completed.has(d));
				const anyDepFailed = deps.some(d => failed.has(d));

				if (anyDepFailed) {
					// Skip tasks whose dependencies failed
					failed.add(taskNum);
					results.push({
						taskIndex: taskNum,
						title: tasks[i].title,
						agent: tasks[i].agent || "code",
						status: "skipped",
						output: `Skipped: dependency #${deps.find(d => failed.has(d))} failed`,
						durationMs: 0,
					});
					notify(`⏭️ Task ${taskNum}: **${tasks[i].title}** — skipped (dependency failed)`, "warning");
				} else if (allDepsMet) {
					ready.push(i);
				}
			}
			return ready;
		}

		const totalTasks = tasks.length;
		let wave = 1;

		notify(`🚀 Executing ${totalTasks} tasks with sub-agents (parallel mode)...`, "info");

		// Execute in waves — each wave runs independent tasks in parallel
		while (completed.size + failed.size < totalTasks) {
			const readyIndices = getReadyTasks();

			if (readyIndices.length === 0) {
				// Deadlock or all done
				break;
			}

			const parallelCount = readyIndices.length;
			if (parallelCount > 1) {
				notify(`\n🔄 **Wave ${wave}** — ${parallelCount} tasks in parallel`, "info");
			}

			for (const idx of readyIndices) {
				const t = tasks[idx];
				notify(`⏳ Task ${idx + 1}: **${t.title}** [${t.agent || "code"}]`, "info");
			}

			// Launch all ready tasks simultaneously (each gets shared context)
			const promises = readyIndices.map(async (idx) => {
				const task = tasks[idx];
				const result = await executeTask(task, agentDefs, process.cwd(), sharedContext);
				result.taskIndex = idx + 1;
				return result;
			});

			const waveResults = await Promise.all(promises);

			// Process results and feed into shared context for next wave
			for (const result of waveResults) {
				results.push(result);

				if (result.status === "success") {
					completed.add(result.taskIndex);
					// Add to shared context so dependent tasks can see this result
					sharedContext.completedTasks.push({
						index: result.taskIndex,
						title: result.title,
						agent: result.agent,
						output: result.output,
					});
				} else {
					failed.add(result.taskIndex);
				}

				const icon = result.status === "success" ? "✅" : "❌";
				const duration = (result.durationMs / 1000).toFixed(1);
				const outputPreview = result.output.length > 500 ? result.output.slice(0, 500) + "..." : result.output;
				notify(`${icon} Task ${result.taskIndex}: **${result.title}** (${duration}s)\n${outputPreview}`,
					result.status === "success" ? "info" : "error");

				progress += `## Task ${result.taskIndex}: ${result.title}\n\n`;
				progress += `- **Status:** ${result.status}\n`;
				progress += `- **Agent:** ${result.agent}\n`;
				progress += `- **Wave:** ${wave}\n`;
				progress += `- **Duration:** ${duration}s\n`;
				progress += `- **Output:**\n\n\`\`\`\n${result.output.slice(0, 3000)}\n\`\`\`\n\n`;
			}

			await writeFile(progressPath, progress, "utf-8");
			wave++;
		}

		// Sort results by task index for consistent reporting
		results.sort((a, b) => a.taskIndex - b.taskIndex);

		const succeededCount = results.filter(r => r.status === "success").length;
		const failedCount = results.filter(r => r.status === "error").length;
		const skippedCount = results.filter(r => r.status === "skipped").length;
		const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0);

		progress += `---\n\n## Summary\n\n`;
		progress += `- **Completed:** ${new Date().toLocaleString()}\n`;
		progress += `- **Waves:** ${wave - 1}\n`;
		progress += `- **Succeeded:** ${succeededCount}/${results.length}\n`;
		progress += `- **Failed:** ${failedCount}\n`;
		progress += `- **Skipped:** ${skippedCount}\n`;
		progress += `- **Total time:** ${(totalTime / 1000).toFixed(1)}s\n`;
		await writeFile(progressPath, progress, "utf-8");

		const statusParts = [`✅ ${succeededCount} succeeded`];
		if (failedCount > 0) statusParts.push(`❌ ${failedCount} failed`);
		if (skippedCount > 0) statusParts.push(`⏭️ ${skippedCount} skipped`);

		notify(
			`\n🏁 **Execution complete!** (${wave - 1} waves)\n` +
			statusParts.join(" | ") + ` | ⏱️ ${(totalTime / 1000).toFixed(1)}s\n` +
			`Progress: \`${progressFile}\``,
			failedCount === 0 ? "info" : "warning"
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
		description: "Create a project plan AND automatically execute all tasks with sub-agents in parallel. Each agent gets its own isolated context, model, and system prompt. Tasks without dependencies run simultaneously.",
		promptSnippet: "Plan + execute projects in parallel waves. Each sub-agent gets isolated context + model. Use prompt-architect patterns for structured task descriptions.",
		promptGuidelines: [
			"When asked to plan or build a project: analyze the request thoroughly, then call the orchestrate tool. It plans AND executes automatically.",
			"CRITICAL: Each task description must be SELF-CONTAINED. The sub-agent has NO access to this conversation. It receives: (1) project context (title, description, spec summary) automatically, (2) outputs from its dependency tasks automatically, (3) your task description. So include specific details: file paths, expected behavior, code patterns, success criteria. Don't repeat the project description — that's injected automatically.",
			"Structure each task description using the prompt-architect pattern: [CONTEXT] what exists and why → [TASK] what to do specifically → [FORMAT] expected output → [CONSTRAINTS] rules and limitations.",
			"Assign agent types strategically: 'explore' (read-only analysis, codebase understanding), 'plan' (architecture, design decisions), 'code' (implementation, file creation/modification), 'test' (write + run tests, validate behavior), 'review' (security audit, quality check, read-only).",
			"Set dependencies to maximize parallelism: tasks without dependencies run simultaneously in the same wave. Only add dependencies when a task truly needs another task's output.",
			"Order tasks logically: explore → plan → code → test → review. But allow independent tasks at each stage to run in parallel.",
			"Set priority=high for critical-path tasks, medium for standard work, low for nice-to-haves.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Concise project title" }),
			description: Type.String({ description: "Full project description: what to build, why, and any relevant context" }),
			goals: Type.Array(Type.String(), { description: "Measurable project goals (what success looks like)" }),
			requirements: Type.Array(Type.String(), { description: "Technical and functional requirements" }),
			architecture: Type.Optional(Type.Array(Type.String(), { description: "Architecture decisions, tech stack choices, trade-offs" })),
			tasks: Type.Array(
				Type.Object({
					title: Type.String({ description: "Clear, action-oriented task title" }),
					description: Type.String({ description: "SELF-CONTAINED task description. Include ALL context the sub-agent needs: file paths, expected behavior, code patterns, conventions. The agent has NO shared history." }),
					agent: Type.Optional(Type.String({ description: "Agent type: explore (read-only analysis), plan (architecture), code (implementation), test (write+run tests), review (quality audit)" })),
					priority: Type.Optional(Type.String({ description: "high (critical path), medium (standard), low (nice-to-have)" })),
					dependencies: Type.Optional(Type.Array(Type.Number(), { description: "Task numbers this depends on (1-indexed). Only add when truly needed — fewer dependencies = more parallelism" })),
					subtasks: Type.Optional(Type.Array(Type.String(), { description: "Specific sub-steps within this task" })),
				}),
				{ description: "Ordered list of tasks. Independent tasks run in parallel. Dependent tasks wait for prerequisites." }
			),
			constraints: Type.Optional(Type.Array(Type.String(), { description: "Hard constraints: frameworks, patterns, rules, things to avoid" })),
			successCriteria: Type.Optional(Type.Array(Type.String(), { description: "How to verify the project is complete and correct" })),
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
				// Build spec summary for shared context
				const specSummary = [
					`Goals: ${p.goals.join("; ")}`,
					`Requirements: ${p.requirements.join("; ")}`,
					p.architecture?.length ? `Architecture: ${p.architecture.join("; ")}` : "",
					p.constraints?.length ? `Constraints: ${p.constraints.join("; ")}` : "",
				].filter(Boolean).join("\n");

				const { results, progressFile } = await executePlan(
					p.tasks, todoFile, notify,
					{ title: p.title, description: p.description, specSummary },
				);

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

			pi.sendUserMessage(
				`Analyze this project and call the orchestrate tool. It will create the plan AND execute all tasks automatically with parallel sub-agents.

## Project
${description}

## Instructions

1. **Analyze** the project: identify goals, requirements, technical constraints, and architecture decisions.

2. **Decompose** into tasks. Each task will be executed by an isolated sub-agent that has:
   - NO access to this conversation
   - NO shared memory or context
   - Its own model and system prompt
   - Full tool access (read, write, edit, bash, grep, find, ls)

3. **Write self-contained task descriptions** using this pattern:
   - CONTEXT: What exists, relevant file paths, current state
   - TASK: Exactly what to implement/analyze/test
   - FORMAT: Expected output (files created, test results, etc.)
   - CONSTRAINTS: Rules, conventions, things to avoid

4. **Assign agents**: explore (read-only analysis), plan (design), code (implementation), test (write+run tests), review (quality audit)

5. **Set dependencies** to maximize parallelism:
   - Tasks without dependencies → same wave → run simultaneously
   - Only add a dependency when a task truly needs another's output
   - Typical flow: explore(wave 1) → plan(wave 2) → code(wave 3) → test(wave 4) → review(wave 5)
   - But independent code tasks can run in parallel within the same wave

6. **Call the orchestrate tool** with all structured data. It handles execution automatically.`
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
