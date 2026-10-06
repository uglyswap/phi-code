import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "phi-code-agent";
import { fauxAssistantMessage, fauxToolCall } from "phi-code-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
} from "../src/core/agent-session-runtime.ts";
import { type CompactionEntry, loadEntriesFromFile, SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

function makeTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function sessionHeader(id: string, cwd: string): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd });
}

describe("fix-session: SessionManager", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	function tempDir(prefix: string): string {
		const dir = makeTempDir(prefix);
		tempDirs.push(dir);
		return dir;
	}

	// #10000
	it("writes a new session file at the first user message, not the first assistant reply", () => {
		const dir = tempDir("fix-session-first-user");
		const session = SessionManager.create(dir, dir);
		const file = session.getSessionFile()!;

		session.appendModelChange("anthropic", "claude-sonnet-4-5");
		expect(existsSync(file)).toBe(false);

		session.appendMessage(userMsg("keep this prompt"));
		expect(existsSync(file)).toBe(true);
		const roles = loadEntriesFromFile(file).flatMap((entry) =>
			entry.type === "message" ? [entry.message.role] : [],
		);
		expect(roles).toEqual(["user"]);

		session.appendMessage(assistantMsg("answer"));
		const content = readFileSync(file, "utf8");
		expect(content.split("\n").filter((line) => line.includes('"type":"session"'))).toHaveLength(1);
		expect(
			loadEntriesFromFile(file).flatMap((entry) => (entry.type === "message" ? [entry.message.role] : [])),
		).toEqual(["user", "assistant"]);
	});

	// #8345
	it("repairs a session file whose last line has no trailing newline", () => {
		const dir = tempDir("fix-session-newline");
		const file = join(dir, "unterminated.jsonl");
		const user = {
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: userMsg("hi"),
		};
		writeFileSync(file, `${sessionHeader("s1", dir)}\n${JSON.stringify(user)}`);

		const session = SessionManager.open(file, dir);
		session.appendMessage(assistantMsg("hello"));

		const entries = loadEntriesFromFile(file);
		expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "message"]);
		expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
	});

	it("does not modify a non-session file while loading it", () => {
		const dir = tempDir("fix-session-not-session");
		const file = join(dir, "other.jsonl");
		writeFileSync(file, '{"type":"something"}');
		expect(loadEntriesFromFile(file)).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe('{"type":"something"}');
	});

	// #8989
	it("re-points a compaction boundary that was a label when forking", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("before"));
		const anchor = session.appendMessage(assistantMsg("anchor"));
		const labelId = session.appendLabelChange(anchor, "checkpoint");
		const kept = session.appendMessage(userMsg("kept"));
		session.appendCompaction("summary", labelId, 1000);
		const after = session.appendMessage(assistantMsg("after"));

		session.createBranchedSession(after);

		const compaction = session.getEntries().find((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(compaction?.firstKeptEntryId).toBe(kept);
		const roles = session.buildSessionContext().messages.map((message) => message.role);
		expect(roles).toEqual(["compactionSummary", "user", "assistant"]);
	});

	// Branch summary fromId = abandoned source leaf
	it("records the abandoned leaf as the branch summary source", () => {
		const session = SessionManager.inMemory();
		const target = session.appendMessage(userMsg("target"));
		session.appendMessage(assistantMsg("abandoned work"));
		const abandonedLeaf = session.appendMessage(userMsg("abandoned leaf"));

		const summaryId = session.branchWithSummary(target, "summary of the abandoned branch");
		const summary = session.getEntry(summaryId);
		expect(summary).toMatchObject({ type: "branch_summary", parentId: target, fromId: abandonedLeaf });
	});
});

describe("fix-session: AgentSessionRuntime", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	function createRuntime(harness: Harness): AgentSessionRuntime {
		const services: AgentSessionServices = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		};
		const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => ({
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: harness.getModel(),
				noTools: "all",
			})),
			services,
			diagnostics: [],
		});
		const runtime = new AgentSessionRuntime(harness.session, services, factory);
		cleanups.push(async () => {
			if (runtime.session !== harness.session) await runtime.dispose();
			harness.cleanup();
		});
		return runtime;
	}

	// #8724
	it("does not append the aborted turn to an in-memory fork", async () => {
		let markToolStarted = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const blockingTool: AgentTool = {
			name: "block",
			label: "Block",
			description: "Wait until aborted",
			parameters: Type.Object({}),
			execute: (_toolCallId, _params, signal) =>
				new Promise<AgentToolResult<unknown>>((resolve) => {
					markToolStarted();
					signal?.addEventListener(
						"abort",
						() => resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
						{ once: true },
					);
				}),
		};
		const harness = await createHarness({ tools: [blockingTool] });
		const runtime = createRuntime(harness);
		harness.setResponses([
			fauxAssistantMessage("first response"),
			fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("unused after abort"),
		]);
		await runtime.session.prompt("first prompt");
		const firstUserEntryId = runtime.session.getUserMessagesForForking()[0]?.entryId;
		expect(firstUserEntryId).toBeDefined();

		const outgoingPrompt = runtime.session.prompt("start blocking tool");
		await toolStarted;
		const forkResult = await runtime.fork(firstUserEntryId!);
		await outgoingPrompt;

		expect(forkResult).toEqual({ cancelled: false, selectedText: "first prompt" });
		expect(runtime.session.messages).toEqual([]);
		expect(runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "message")).toEqual([]);
	});

	// #8985
	it("never overwrites a stored session when importing a file with the same name", async () => {
		const harness = await createHarness();
		const runtime = createRuntime(harness);
		const sessionDir = join(harness.tempDir, "sessions");
		const importDir = join(harness.tempDir, "import");
		const storedPath = join(sessionDir, "collision.jsonl");
		const importPath = join(importDir, "collision.jsonl");
		const storedSession = `${sessionHeader("stored", harness.tempDir)}\n`;
		const importedSession = `${sessionHeader("imported", harness.tempDir)}\n`;
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(importDir, { recursive: true });
		writeFileSync(storedPath, storedSession);
		writeFileSync(importPath, importedSession);
		// Switch to a file-backed session so imports land in `sessionDir`.
		await runtime.switchSession(storedPath);
		expect(runtime.session.sessionManager.getSessionDir()).toBe(sessionDir);
		const storedBeforeImport = readFileSync(storedPath, "utf8");

		await runtime.importFromJsonl(importPath);

		expect(readFileSync(storedPath, "utf8")).toBe(storedBeforeImport);
		expect(storedBeforeImport.startsWith(storedSession)).toBe(true);
		expect(runtime.session.sessionFile).toBe(join(sessionDir, "collision-1.jsonl"));
		expect(readFileSync(runtime.session.sessionFile!, "utf8")).toContain('"id":"imported"');
	});
});
