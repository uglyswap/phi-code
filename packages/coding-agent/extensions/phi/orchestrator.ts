/**
 * Orchestrator Extension - Full-cycle project planning and execution
 *
 * WORKFLOW (single command):
 *   /plan <description> → 5 sequential agent phases → each with its own model
 *
 * The orchestrator uses event-driven phase chaining:
 *   1. Send phase 1 message with model A
 *   2. Detect when agent goes idle (output event + polling)
 *   3. Switch to model B, send phase 2
 *   4. Repeat until all 5 phases complete
 *
 * Commands:
 *   /plan   — Full workflow: plan + execute with agents
 *   /run    — Re-execute an existing plan
 *   /plans  — List plans and their execution status
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
			goals: Type.Union([Type.Array(Type.String()), Type.String()], { description: "Measurable project goals (what success looks like)" }),
			requirements: Type.Union([Type.Array(Type.String()), Type.String()], { description: "Technical and functional requirements" }),
			architecture: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Architecture decisions, tech stack choices, trade-offs" })),
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
			constraints: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Hard constraints: frameworks, patterns, rules, things to avoid" })),
			successCriteria: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "How to verify the project is complete and correct" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const raw = params as any;

			// Normalize string fields to arrays (some models send strings instead of arrays)
			const toArray = (v: any): string[] => {
				if (!v) return [];
				if (Array.isArray(v)) return v;
				if (typeof v === "string") return v.split("\n").map((s: string) => s.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);
				return [];
			};

			const p = {
				title: raw.title as string,
				description: raw.description as string,
				goals: toArray(raw.goals),
				requirements: toArray(raw.requirements),
				architecture: raw.architecture ? toArray(raw.architecture) : undefined,
				tasks: raw.tasks as TaskDef[],
				constraints: raw.constraints ? toArray(raw.constraints) : undefined,
				successCriteria: raw.successCriteria ? toArray(raw.successCriteria) : undefined,
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

	// ─── Orchestration State ─────────────────────────────────────────

	interface AgentDef {
		name: string;
		tools: string[];
		systemPrompt: string;
	}

	interface OrchestratorPhase {
		key: string;
		label: string;
		model: string;
		fallback: string;
		agent: AgentDef | null;
		instruction: string;
	}

	let phaseQueue: OrchestratorPhase[] = [];
	let orchestrationActive = false;
	let activeAgentPrompt: string | null = null;
	let activeAgentTools: string[] | null = null;
	let savedTools: string[] | null = null;
	let phasePending = false; // true while waiting for a phase to complete

	/**
	 * Parse agent .md file with YAML frontmatter
	 */
	function loadAgentDef(name: string): AgentDef | null {
		const dirs = [
			join(process.cwd(), ".phi", "agents"),
			join(homedir(), ".phi", "agent", "agents"),
		];
		for (const dir of dirs) {
			const filePath = join(dir, `${name}.md`);
			try {
				const content = readFileSync(filePath, "utf-8");
				const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
				if (!fmMatch) continue;
				const fields: Record<string, string> = {};
				for (const line of fmMatch[1].split("\n")) {
					const m = line.match(/^(\w+):\s*(.*)$/);
					if (m) fields[m[1]] = m[2].trim();
				}
				return {
					name: fields.name || name,
					tools: (fields.tools || "").split(",").map(t => t.trim()).filter(Boolean),
					systemPrompt: fmMatch[2].trim(),
				};
			} catch { continue; }
		}
		return null;
	}

	/**
	 * Load routing config and build phase queue with model assignments + agent definitions.
	 * Each phase now reads outputs from previous phases and writes structured outputs.
	 */
	function buildPhases(description: string): OrchestratorPhase[] {
		const routingPath = join(homedir(), ".phi", "agent", "routing.json");
		let routing: any = { routes: {}, default: { model: "default" } };
		try {
			routing = JSON.parse(readFileSync(routingPath, "utf-8"));
		} catch { /* no routing config */ }

		function getModel(routeKey: string): { preferred: string; fallback: string } {
			const route = routing.routes?.[routeKey];
			return {
				preferred: route?.preferredModel || routing.default?.model || "default",
				fallback: route?.fallback || routing.default?.model || "default",
			};
		}

		const explore = getModel("explore");
		const plan = getModel("plan");
		const code = getModel("code");
		const test = getModel("test");
		const review = getModel("review");

		const ts = timestamp();

		return [
			{
				key: "explore", label: "🔍 Phase 1 — EXPLORE", model: explore.preferred, fallback: explore.fallback,
				agent: loadAgentDef("explore"),
				instruction: `You are the EXPLORE agent. Analyze the project requirements and existing codebase.

**Project Request:** ${description}

**Your tasks:**
1. List all existing files and read key ones
2. Identify tech stack, patterns, and constraints
3. Create a STRUCTURED PROJECT BRIEF in \`.phi/plans/brief-${ts}.md\`:
   - Context: what exists now
   - Objective: what needs to be built
   - Requirements: specific features needed
   - Tech decisions: frameworks, patterns to use
   - Constraints: what to NOT break

**Step 4:** Write your findings to \`.phi/plans/explore-${ts}.md\`

**Knowledge Graph:**
After your analysis, use \`ontology_add\` to save key project entities AND their relations:
- Add entities for: the project, each major library, each module/directory
- Add relations between them: "uses", "contains", "depends_on", "implements"
- Example: entity "finance-tracker" (type: Project) → relation "uses" → entity "ink" (type: Library)
- ALWAYS create relations — entities without relations are useless

**Format for the project brief:**
\`\`\`markdown
## Project Brief

### Context
[Analyze what the user is asking for]

### Objective
[Clear, specific goal]

### Requirements
[Bullet list of what must be built]

### Tech Decisions
[Frameworks, patterns, architecture choices]

### Constraints
- Production-quality code, no placeholders
- Every function fully implemented
- Follow existing patterns if codebase exists
- [Any other specific constraints]
\`\`\``,
			},
			{
				key: "plan", label: "📐 Phase 2 — PLAN", model: plan.preferred, fallback: plan.fallback,
				agent: loadAgentDef("plan"),
				instruction: `You are the PLAN agent. Design the architecture and create a detailed task list.

**Context Retrieval:**
1. Use \`ontology_query\` to retrieve all entities and relations from Phase 1
2. Use \`memory_search\` with project-relevant keywords to find existing notes
3. Use this knowledge to inform your plan

**Project Request:** ${description}

**Step 1:** Read \`.phi/plans/brief-*.md\` (created by the explore phase)
**Step 2:** Read \`.phi/plans/explore-*.md\` to understand the codebase analysis
**Step 3:** Design the architecture based on findings
**Step 4:** Create a DETAILED TODO LIST in \`.phi/plans/todo-${ts}.md\`:
   For each task:
   - Task number and title
   - Agent assignment (code/test)
   - Files to create/modify
   - Specific implementation details
   - Dependencies on other tasks

**Format for the todo list:**
\`\`\`markdown
# TODO: Project Tasks

## Task 1: [Task Title] [agent-type]
- [ ] Specific implementation details
- [ ] Files to create: path/to/file.ext
- [ ] Expected behavior
- Dependencies: None

## Task 2: [Task Title] [agent-type]
- [ ] Implementation details
- Dependencies: Task 1
\`\`\`

Before finishing, use \`memory_write\` to save your plan summary with relevant tags for future reference.`,
			},
			{
				key: "code", label: "💻 Phase 3 — CODE", model: code.preferred, fallback: code.fallback,
				agent: loadAgentDef("code"),
				instruction: `You are the CODE agent. Implement the complete project.

**Context Retrieval:**
1. Use \`memory_search\` with project keywords to find notes from previous phases
2. Use \`ontology_query\` to understand the project structure and dependencies
3. Use this context to guide implementation

**Project Request:** ${description}

**Step 1:** Read \`.phi/plans/brief-*.md\` for project context
**Step 2:** Read \`.phi/plans/todo-*.md\` to get your task list
**Step 3:** Implement EVERY task from the todo list, in order
**Step 4:** Write a progress report to \`.phi/plans/progress-${ts}.md\`

**Rules:**
- Create every file listed in the plan
- No placeholders, no TODOs, no stubs
- Every function must be fully implemented
- Follow the architecture from the plan
- Check off tasks in your progress report as you complete them

**Progress report format:**
\`\`\`markdown
# Progress Report

## Completed Tasks
- [x] Task 1: Description - DONE
- [x] Task 2: Description - DONE

## Files Created
- path/to/file1.ext - Purpose
- path/to/file2.ext - Purpose

## Implementation Notes
[Any important decisions or changes made]
\`\`\`

After implementation, use \`memory_write\` to save a summary of what was built, patterns used, and any issues encountered.

**CRITICAL RULES:**
- Write ONE file per tool call — NEVER combine multiple files in a single response
- Keep each file under 500 lines. If longer, split into modules
- After writing each file, verify it exists with \`ls\` before proceeding`,
			},
			{
				key: "test", label: "🧪 Phase 4 — TEST", model: test.preferred, fallback: test.fallback,
				agent: loadAgentDef("test"),
				instruction: `You are the TEST agent. Verify the implementation.

**Context Retrieval:**
1. Use \`memory_search\` to find implementation notes from the CODE phase
2. Use \`ontology_query\` to understand the project architecture
3. Use this context to focus your testing

**Project Request:** ${description}

**Step 1:** Read \`.phi/plans/todo-*.md\` to know what was planned
**Step 2:** Read \`.phi/plans/progress-*.md\` to see what was done
**Step 3:** Run the code, check for errors, test key features
**Step 4:** Fix any errors you find
**Step 5:** Write test results to \`.phi/plans/test-${ts}.md\`

**Test report format:**
\`\`\`markdown
# Test Report

## Tests Executed
- [ ] Feature 1: Description - PASS/FAIL
- [ ] Feature 2: Description - PASS/FAIL

## Errors Found & Fixed
- Error: Description
  - Fix: What was done

## Manual Testing
- Tested: What was manually verified
- Result: Pass/Fail with details

## Final Status
✅ All tests pass / ❌ Issues remain
\`\`\`

**CRITICAL RULES:**
- NEVER run a server with \`&\` without cleanup. Always use: \`timeout 15 bash -c 'node src/index.js & PID=$!; sleep 2; curl ...; kill $PID'\`
- ALWAYS kill background processes after testing
- If a test hangs, use \`timeout\` to prevent deadlock
- NEVER put tool calls inside thinking blocks. Always use the proper JSON tool call format
- NEVER modify source code permanently for testing. Use environment variables: \`PORT=3001 node server.js\` instead of editing files
- NEVER create .env files with fake credentials. Use inline env vars: \`API_KEY=test node server.js\`
- For port conflicts on Windows, use: \`netstat -ano | findstr :PORT\` and \`taskkill /PID <pid> /F\`
- For port conflicts on Linux/Mac, use: \`lsof -ti:PORT | xargs kill -9\`
- Always clean up after tests: kill background processes, remove temp files

After testing, use \`memory_write\` to save test results, bugs found, and lessons learned.`,
			},
			{
				key: "review", label: "🔍 Phase 5 — REVIEW", model: review.preferred, fallback: review.fallback,
				agent: loadAgentDef("review"),
				instruction: `You are the REVIEW agent. Final quality review.

**Context Retrieval:**
1. Use \`memory_search\` to find all notes from previous phases (explore, plan, code, test)
2. Use \`ontology_query\` to understand the full project architecture
3. Review all \`.phi/plans/*.md\` files for complete context

**Project Request:** ${description}

**Step 1:** Read all \`.phi/plans/*.md\` files
**Step 2:** Review code quality, security, performance
**Step 3:** Fix any issues found
**Step 4:** Write final report to \`.phi/plans/review-${ts}.md\`

**Review checklist:**
- Code quality: naming, structure, readability
- Security: input validation, error handling
- Performance: efficiency, resource usage
- Documentation: comments, README if needed
- Completeness: all requirements met

**Final report format:**
\`\`\`markdown
# Final Review

## Code Quality ✅/❌
- Structure: Good/Needs work
- Naming: Clear/Unclear
- Comments: Adequate/Missing

## Security ✅/❌
- Input validation: Present/Missing
- Error handling: Robust/Weak

## Performance ✅/❌
- Efficiency: Good/Could improve
- Resource usage: Optimal/Excessive

## Completeness ✅/❌
- All requirements met: Yes/No
- All files created: Yes/No

## Final Verdict
✅ Project ready for production / ❌ Issues need resolution
\`\`\`

After your review, use \`memory_write\` to save:
- Key lessons learned about this project type
- Patterns that worked well
- Common mistakes to avoid in future projects
Tag the note with relevant keywords for vector search.`,
			},
		];
	}

	/**
	 * Switch model for the current phase.
	 */
	async function switchModelForPhase(phase: OrchestratorPhase, ctx: any): Promise<string> {
		const available = ctx.modelRegistry?.getAvailable?.() || [];
		const preferred = available.find((m: any) => m.id === phase.model);
		const fallback = available.find((m: any) => m.id === phase.fallback);
		const target = preferred || fallback;

		if (target && target.id !== ctx.model?.id) {
			const switched = await pi.setModel(target);
			if (switched) return target.id;
		}
		return ctx.model?.id || phase.model;
	}

	/**
	 * Activate agent for a phase: set system prompt + restrict tools.
	 */
	function activateAgent(phase: OrchestratorPhase, ctx: any) {
		if (phase.agent) {
			// Save current tools for restoration
			if (!savedTools) {
				savedTools = pi.getActiveTools();
			}
			// Set agent's system prompt (will be injected via before_agent_start)
			activeAgentPrompt = phase.agent.systemPrompt;
			// Restrict tools to agent's allowed tools
			if (phase.agent.tools.length > 0) {
				// Always include memory tools in orchestration phases
				const memoryTools = ['memory_search', 'memory_write', 'memory_read', 'ontology_add', 'ontology_query'];
				const agentTools = [...phase.agent.tools, ...memoryTools.filter(t => !phase.agent.tools.includes(t))];
				activeAgentTools = agentTools;
				pi.setActiveTools(agentTools);
			}
		} else {
			activeAgentPrompt = null;
			activeAgentTools = null;
		}
	}

	/**
	 * Deactivate agent: restore tools, clear prompt override.
	 */
	function deactivateAgent() {
		activeAgentPrompt = null;
		activeAgentTools = null;
		if (savedTools) {
			pi.setActiveTools(savedTools);
			savedTools = null;
		}
	}

	/**
	 * Send the next phase in the queue.
	 */
	function setOrchestrationActive(active: boolean) {
		orchestrationActive = active;
		(globalThis as any).__phiOrchestrationActive = active;
	}

	function sendNextPhase(ctx: any) {
		if (phaseQueue.length === 0) {
			setOrchestrationActive(false);
			phasePending = false;
			deactivateAgent();
			ctx.ui.notify(`\n✅ **All 5 phases complete!**`, "info");
			return;
		}

		const phase = phaseQueue.shift()!;
		phasePending = true;

		switchModelForPhase(phase, ctx).then((modelId) => {
			activateAgent(phase, ctx);
			const agentName = phase.agent?.name || phase.key;
			ctx.ui.notify(`\n${phase.label} → \`${modelId}\` (agent: ${agentName})`, "info");
			// Small delay to let the model switch settle, then send instruction
			setTimeout(() => pi.sendUserMessage(phase.instruction), 500);
		});
	}

	// ─── System Prompt Injection — Agent personas ────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!orchestrationActive || !activeAgentPrompt) {
			return { };
		}
		// Replace system prompt with the active agent's prompt
		return { systemPrompt: activeAgentPrompt };
	});

	// ─── Agent End Event — Phase Chaining ────────────────────────────
	// "agent_end" fires when the full agent loop completes (all tool calls
	// resolved, response fully generated). This is the ONLY reliable signal
	// that a phase has finished.
	//
	// Previous approach used "output" event which DOES NOT EXIST in Pi.
	// That's why phases 2-5 never executed.

	pi.on("agent_end", async (event, ctx) => {
		if (!orchestrationActive || !phasePending) return;

		// Capture the most informative assistant message for context passing
		// The last message is often trivial ("Good, file created."). Find the longest
		// text-only assistant message instead — that's usually the real analysis/plan.
		const messages = event.messages || [];
		const assistantMessages = messages.filter(m => m.role === 'assistant');
		let bestOutput = '';
		let bestLength = 0;
		for (const msg of assistantMessages) {
			if (!msg.content) continue;
			const textParts = Array.isArray(msg.content)
				? msg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text)
				: [String(msg.content)];
			const combined = textParts.join('\n');
			if (combined.length > bestLength) {
				bestLength = combined.length;
				bestOutput = combined;
			}
		}
		const lastOutput = bestOutput.slice(0, 4000);

		// Inject previous phase output into next phase
		if (lastOutput && phaseQueue.length > 0) {
			phaseQueue[0].instruction += `\n\n**Previous phase output (summary):**\n${lastOutput}`;
		}

		// Phase complete — chain to next
		phasePending = false;
		sendNextPhase(ctx);
	});

	// ─── /plan Command — Full workflow ───────────────────────────────

	pi.registerCommand("plan", {
		description: "Plan AND execute a project — 5 phases, each with its own model from routing.json",
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

			// Build phases with model assignments + agent definitions
			const phases = buildPhases(description);
			phaseQueue = phases.slice(1); // Queue phases 2-5
			setOrchestrationActive(true);
			phasePending = true;
			const firstPhase = phases[0];

			ctx.ui.notify(`📋 **Orchestrator started** — 5 phases with model routing + agent roles\n`, "info");

			// Show the plan
			for (const p of phases) {
				const agentName = p.agent?.name || p.key;
				const toolCount = p.agent?.tools.length || 0;
				ctx.ui.notify(`  ${p.label} → \`${p.model}\` (agent: ${agentName}, ${toolCount} tools)`, "info");
			}
			ctx.ui.notify("", "info");

			// Switch model and activate agent for first phase
			const modelId = await switchModelForPhase(firstPhase, ctx);
			activateAgent(firstPhase, ctx);
			const agentName = firstPhase.agent?.name || firstPhase.key;
			ctx.ui.notify(`${firstPhase.label} → \`${modelId}\` (agent: ${agentName})`, "info");
			setTimeout(() => pi.sendUserMessage(firstPhase.instruction), 200);
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
