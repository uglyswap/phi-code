// Library entry point (package.json "main"/"types"). The bot itself is the
// `mom` binary (main.ts), which has top-level side effects and must not be
// imported; this module only re-exports side-effect-free building blocks.
export { type AccessPolicy, isUserAllowed, parseAccessPolicy } from "./access.ts";
export { type ProviderAuthSource, resolveProviderApiKey } from "./api-key.ts";
export {
	createEventsWatcher,
	EventsWatcher,
	type ImmediateEvent,
	type MomEvent,
	type OneShotEvent,
	type PeriodicEvent,
} from "./events.ts";
export { redactSecrets } from "./redact.ts";
export {
	buildCommandEnv,
	createExecutor,
	type ExecOptions,
	type ExecResult,
	type Executor,
	parseSandboxArg,
	type SandboxConfig,
} from "./sandbox.ts";
export type { SlackContext, SlackEvent } from "./slack.ts";
