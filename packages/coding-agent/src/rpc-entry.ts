#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { setBrandedEnv } from "./core/env-vars.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
setBrandedEnv(process.env, "CODING_AGENT", "true");
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

main(["--mode", "rpc", ...process.argv.slice(2)]);
