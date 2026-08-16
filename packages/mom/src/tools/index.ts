import type { AgentTool } from "phi-code-agent";
import type { Executor } from "../sandbox.ts";
import { attachTool } from "./attach.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export { setUploadFunction, setWorkspaceRoot } from "./attach.ts";

export function createMomTools(executor: Executor): AgentTool<any>[] {
	return [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		attachTool,
	];
}
