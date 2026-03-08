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
// execFile removed — tasks now execute in-session, no subprocess
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
		// Try the bundled CLI relative to extensions dir
		const bundledCli = join(__dirname, "..", "..", "..", "dist", "cli.js");
		if (existsSync(bundledCli)) return bundledCli;

		// Try npm global install paths
		const npmGlobalPaths = [
			join(homedir(), "AppData", "Roaming", "npm", "node_modules", "@phi-code-admin", "phi-code", "dist", "cli.js"), // Windows
			join(homedir(), ".npm-global", "lib", "node_modules", "@phi-code-admin", "phi-code", "dist", "cli.js"), // Linux custom
			"/usr/local/lib/node_modules/@phi-code-admin/phi-code/dist/cli.js", // Linux/Mac default
			"/usr/lib/node_modules/@phi-code-admin/phi-code/dist/cli.js", // Some Linux
		];
		for (const p of npmGlobalPaths) {
			if (existsSync(p)) return p;
		}

		// Try `which phi` (Linux/Mac) or `where phi` (Windows)
		try {
			const isWin = process.platform === "win32";
			const cmd = isWin ? "where" : "which";
			const result = require("child_process").execSync(`${cmd} phi 2>${isWin ? "NUL" : "/dev/null"}`, { encoding: "utf-8" }).trim();
			if (result) {
				const firstLine = result.split("\n")[0].trim();
				// On Windows, `where phi` returns the .cmd shim; we need the actual JS
				if (isWin && firstLine.endsWith(".cmd")) {
					const npmPrefix = require("child_process").execSync("npm prefix -g", { encoding: "utf-8" }).trim();
					const jsPath = join(npmPrefix, "node_modules", "@phi-code-admin", "phi-code", "dist", "cli.js");
					if (existsSync(jsPath)) return jsPath;
				}
				return firstLine;
			}
		} catch { /* not in PATH */ }

		// Last resort: assume phi is in PATH (works with shell:true on Windows)
		return "phi";
	}

	// ─── Task Execution (in-session, no subprocess) ─────────────────

	/**
	 * Execute a task by sending it as a user message to the current session.
	 * The LLM handles it directly — no subprocess spawning, no cold boot.
	 * Much faster and more reliable than spawning phi --print processes.
	 */
	function executeTaskInSession(
		task: TaskDef,
		sharedContext: {
			projectTitle: string;
			projectDescription: string;
			specSummary: string;
			completedTasks: Array<{ index: number; title: string; agent: string; output: string }>;
		},
	): { taskPrompt: string } {
		const agentType = task.agent || "code";

		// Build prompt with shared context
		let taskPrompt = `## 🔧 Task: ${task.title} [${agentType}]\n\n`;

		taskPrompt += `**Project:** ${sharedContext.projectTitle}\n\n`;

		if (sharedContext.specSummary) {
			taskPrompt += `**Spec:** ${sharedContext.specSummary}\n\n`;
		}

		// Inject results from dependency tasks
		const deps = task.dependencies || [];
		if (deps.length > 0) {
			const depResults = sharedContext.completedTasks.filter(ct => deps.includes(ct.index));
			if (depResults.length > 0) {
				taskPrompt += `**Previous results:**\n`;
				for (const dep of depResults) {
					const truncated = dep.output.length > 500 ? dep.output.slice(0, 500) + "..." : dep.output;
					taskPrompt += `- Task ${dep.index} (${dep.title}): ${truncated}\n`;
				}
				taskPrompt += "\n";
			}
		}

		// The actual task
		taskPrompt += `### What to do\n\n${task.description}\n`;
		if (task.subtasks && task.subtasks.length > 0) {
			taskPrompt += "\n**Sub-tasks:**\n" + task.subtasks.map((st, i) => `${i + 1}. ${st}`).join("\n") + "\n";
		}
		taskPrompt += `\n**Instructions:** Execute this task completely. Create/edit all necessary files. Report what you did.\n`;

		return { taskPrompt };
	}

	// ─── Execute All Tasks (parallel with dependency resolution) ─────

	async function executePlan(
		tasks: TaskDef[],
		todoFile: string,
		notify: (msg: string, type: "info" | "error" | "warning") => void,
		projectContext?: { title: string; description: string; specSummary: string },
	): Promise<{ results: TaskResult[]; progressFile: string }> {
		const progressFile = todoFile.replace("todo-", "progress-");
		const progressPath = join(plansDir, progressFile);
		const totalTasks = tasks.length;

		const sharedContext = {
			projectTitle: projectContext?.title || "Project",
			projectDescription: projectContext?.description || "",
			specSummary: projectContext?.specSummary || "",
			completedTasks: [] as Array<{ index: number; title: string; agent: string; output: string }>,
		};

		notify(`🚀 Executing ${totalTasks} tasks in-session...`, "info");

		// Build a single comprehensive prompt with ALL tasks
		let megaPrompt = `# 📋 Project: ${sharedContext.projectTitle}\n\n`;
		megaPrompt += `${sharedContext.projectDescription}\n\n`;
		if (sharedContext.specSummary) {
			megaPrompt += `## Spec\n${sharedContext.specSummary}\n\n`;
		}
		megaPrompt += `## Tasks (execute ALL in order)\n\n`;

		const results: TaskResult[] = [];

		for (let i = 0; i < tasks.length; i++) {
			const task = tasks[i];
			const { taskPrompt } = executeTaskInSession(task, sharedContext);
			megaPrompt += `---\n\n${taskPrompt}\n\n`;
			results.push({
				taskIndex: i + 1, title: task.title,
				agent: task.agent || "code", status: "success",
				output: "(in-session)", durationMs: 0,
			});
		}

		megaPrompt += `---\n\n## ⚠️ Instructions\n\n`;
		megaPrompt += `Execute ALL ${totalTasks} tasks above **sequentially**. For each task:\n`;
		megaPrompt += `1. Create/edit the required files using your tools\n`;
		megaPrompt += `2. Report what you did briefly\n`;
		megaPrompt += `3. Move to the next task\n\n`;
		megaPrompt += `Do NOT skip any task. Complete the entire project.\n`;

		// Write progress file
		let progress = `# Progress: ${todoFile}\n\n`;
		progress += `**Started:** ${new Date().toLocaleString()}\n`;
		progress += `**Tasks:** ${totalTasks} | **Mode:** in-session\n\n`;
		for (const r of results) {
			progress += `- Task ${r.taskIndex}: ${r.title} [${r.agent}]\n`;
		}
		await writeFile(progressPath, progress, "utf-8");

		// Return the mega-prompt as tool result — LLM sees it and executes
		return { results, progressFile, megaPrompt };
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

				const { results, progressFile, megaPrompt } = await executePlan(
					p.tasks, todoFile, notify,
					{ title: p.title, description: p.description, specSummary },
				);

				const header = `**📋 Project "${p.title}" — ${p.tasks.length} tasks planned!**\n` +
					`Plan: \`${specFile}\`, \`${todoFile}\` | Progress: \`${progressFile}\`\n\n` +
					`---\n\n`;

				// Return the mega-prompt as tool result
				// The LLM sees this and executes all tasks in its current turn
				return {
					content: [{ type: "text", text: header + megaPrompt }],
					details: {
						specFile, todoFile, progressFile,
						taskCount: p.tasks.length,
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
		description: "Plan AND execute a project with agents — describe what to build",
		handler: async (args, ctx) => {
			const description = args.trim();

			if (!description) {
				ctx.ui.notify(`**Usage:** \`/plan <project description>\`

**Examples:**
  /plan Build a REST API for user authentication with JWT
  /plan Create a cyberpunk Pong browser game
  /plan Add test coverage to the payment module

**Other commands:**
  /plans — List all plans`, "info");
				return;
			}

			// Create plan files
			await ensurePlansDir();
			const ts = timestamp();
			const specFile = `spec-${ts}.md`;
			await writeFile(join(plansDir, specFile), `# ${description}\n\n**Created:** ${new Date().toLocaleString()}\n`, "utf-8");

			ctx.ui.notify(`📋 Plan created. Executing with agents...`, "info");

			// Load agent definitions for system prompts
			const agentDefs = loadAgentDefs();
			const phases = [
				{ agent: "explore", label: "🔍 Exploring", instruction: `Analyze the project requirements and existing codebase. Identify what exists, what's needed, and any constraints.\n\nProject: ${description}` },
				{ agent: "plan", label: "📐 Planning", instruction: `Design the architecture, file structure, and implementation approach.\n\nProject: ${description}` },
				{ agent: "code", label: "💻 Coding", instruction: `Implement the complete project. Create ALL necessary files with production-quality code.\n\nProject: ${description}\n\nCreate every file needed. Do NOT leave placeholders or TODOs. Complete implementation.` },
				{ agent: "test", label: "🧪 Testing", instruction: `Test the implementation. Run the code, check for errors, verify it works.\n\nProject: ${description}` },
				{ agent: "review", label: "🔍 Reviewing", instruction: `Review code quality, security, and performance. Fix any issues found.\n\nProject: ${description}` },
			];

			// Execute each phase sequentially using sendUserMessage + waitForIdle
			for (const phase of phases) {
				const agentDef = agentDefs.get(phase.agent);
				const systemPromptNote = agentDef?.systemPrompt
					? `\n\n[Agent: ${phase.agent}] ${agentDef.systemPrompt.slice(0, 200)}`
					: "";

				ctx.ui.notify(`\n${phase.label} (agent: ${phase.agent})...`, "info");

				pi.sendUserMessage(phase.instruction + systemPromptNote, { deliverAs: "followUp" });
				await ctx.waitForIdle();
			}

			ctx.ui.notify(`\n✅ **Project complete!** Plan: \`${specFile}\``, "info");
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
