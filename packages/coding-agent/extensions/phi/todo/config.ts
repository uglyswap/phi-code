import type { GuidanceFields } from "./rpiv-config/index.js";
import { configPath, loadJsonConfig, validateGuidanceFields } from "./rpiv-config/index.js";

const CONFIG_PATH = configPath("rpiv-todo");

interface TodoConfig {
	guidance?: GuidanceFields;
}

export function loadConfig(): TodoConfig {
	return loadJsonConfig<TodoConfig>(CONFIG_PATH);
}

export { validateGuidanceFields };
