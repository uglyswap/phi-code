import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI, ProviderConfig } from "../src/core/extensions/types.ts";

const providerConfig = {
	baseUrl: "https://provider.test/v1",
	apiKey: "provider-test-key",
} satisfies ProviderConfig;

describe("fix-core #8423 extension factory failure", () => {
	it("discards runtime changes and disables the failed API", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		let capturedApi: ExtensionAPI | undefined;
		let eventCalls = 0;
		let flagDuringLoad: boolean | string | undefined;

		await loadExtensionFromFactory(
			(pi) => pi.registerProvider("working-provider", providerConfig),
			process.cwd(),
			eventBus,
			runtime,
			"<working>",
		);
		await expect(
			loadExtensionFromFactory(
				(pi) => {
					capturedApi = pi;
					pi.events.on("factory-failure", () => {
						eventCalls++;
					});
					pi.registerFlag("failed-flag", { type: "boolean", default: true });
					flagDuringLoad = pi.getFlag("failed-flag");
					pi.unregisterProvider("working-provider");
					pi.registerProvider("failed-provider", providerConfig);
					throw new Error("factory failed");
				},
				process.cwd(),
				eventBus,
				runtime,
				"<failing>",
			),
		).rejects.toThrow("factory failed");

		eventBus.emit("factory-failure", undefined);
		expect(flagDuringLoad).toBe(true);
		expect(runtime.flagValues.has("failed-flag")).toBe(false);
		expect(runtime.pendingProviderRegistrations.map(({ name }) => name)).toEqual(["working-provider"]);
		expect(eventCalls).toBe(0);
		expect(capturedApi).toBeDefined();
		expect(() => capturedApi?.registerFlag("late-flag", { type: "boolean", default: true })).toThrow(
			'Extension "<failing>" failed to load and its API is no longer active.',
		);
	});

	it("does not discard a concurrently loaded factory's provider", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		let releaseFailure!: () => void;
		const waitBeforeFailure = new Promise<void>((resolve) => {
			releaseFailure = resolve;
		});
		const failingLoad = loadExtensionFromFactory(
			async (pi) => {
				pi.registerProvider("failed-provider", providerConfig);
				await waitBeforeFailure;
				throw new Error("factory failed");
			},
			process.cwd(),
			eventBus,
			runtime,
			"<failing>",
		);

		await loadExtensionFromFactory(
			(pi) => pi.registerProvider("working-provider", providerConfig),
			process.cwd(),
			eventBus,
			runtime,
			"<working>",
		);
		releaseFailure();

		await expect(failingLoad).rejects.toThrow("factory failed");
		expect(runtime.pendingProviderRegistrations.map(({ name }) => name)).toEqual(["working-provider"]);
	});
});

describe("fix-core extension registration validation", () => {
	const load = (factory: (pi: ExtensionAPI) => void) =>
		loadExtensionFromFactory(factory, process.cwd(), createEventBus(), createExtensionRuntime(), "<validation>");

	it("rejects a tool without an object parameter schema (#9300)", async () => {
		await expect(
			load((pi) => {
				pi.registerTool({
					name: "noop",
					label: "No-op",
					description: "Do nothing",
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				} as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
			}),
		).rejects.toThrow('Tool "noop" registered by extension "<validation>" must define an object parameter schema.');
	});

	it("rejects a flag default that does not match the flag type (#8123)", async () => {
		await expect(
			load((pi) => {
				pi.registerFlag("safe-mode", { type: "boolean", default: "false" } as unknown as {
					type: "boolean";
					default?: boolean;
				});
			}),
		).rejects.toThrow('Invalid default for flag "safe-mode": expected boolean, got string');
	});

	it("rejects commands without a name or handler", async () => {
		await expect(
			load((pi) => {
				pi.registerCommand("", { description: "x", handler: async () => {} });
			}),
		).rejects.toThrow("must have a non-empty string name");
		await expect(
			load((pi) => {
				pi.registerCommand("broken", { description: "x" } as unknown as Parameters<
					ExtensionAPI["registerCommand"]
				>[1]);
			}),
		).rejects.toThrow('Command "/broken" registered by extension "<validation>" must define handler().');
	});
});
