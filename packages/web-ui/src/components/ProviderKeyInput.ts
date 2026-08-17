import { i18n } from "@mariozechner/mini-lit";
import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Api, Context, Model } from "phi-code-ai";
import { complete, getModel, getModels } from "phi-code-ai/compat";
import { getAppStorage } from "../storage/app-storage.ts";
import { applyProxyIfNeeded } from "../utils/proxy-utils.ts";
import { Input } from "./Input.ts";

/**
 * Preferred models for the "test key" round-trip, cheapest-first.
 *
 * These are preferences, not requirements: the catalogue is regenerated from the
 * live provider APIs at every release, so pinned ids rot. When none of them is
 * still listed, resolveTestModel falls back to the provider's cheapest model —
 * a missing id used to report a perfectly valid key as invalid (xAI and Z.ai
 * both lost their pinned model in the pi 0.84 catalogue).
 *
 * A provider absent from this map is not tested at all (Ollama and friends:
 * the local model set is unknown).
 */
const PREFERRED_TEST_MODELS: Record<string, string[]> = {
	anthropic: ["claude-haiku-4-5"],
	openai: ["gpt-4o-mini"],
	google: ["gemini-2.5-flash"],
	groq: ["openai/gpt-oss-20b"],
	openrouter: ["z-ai/glm-4.6"],
	"vercel-ai-gateway": ["anthropic/claude-opus-4.5"],
	cerebras: ["gpt-oss-120b"],
	xai: ["grok-4-fast-non-reasoning", "grok-build-0.1"],
	zai: ["glm-4.5-air", "glm-5-turbo"],
};

/** Resolve a model to probe a key with, or undefined when the provider has none. */
export function resolveTestModel(provider: string, preferred: readonly string[]): Model<Api> | undefined {
	for (const id of preferred) {
		const model = getModel(provider, id);
		if (model) return model;
	}
	const models = getModels(provider);
	if (models.length === 0) return undefined;
	return [...models].sort(
		(a, b) => (a.cost?.input ?? Number.POSITIVE_INFINITY) - (b.cost?.input ?? Number.POSITIVE_INFINITY),
	)[0];
}

@customElement("provider-key-input")
export class ProviderKeyInput extends LitElement {
	@property() provider = "";
	@state() private keyInput = "";
	@state() private testing = false;
	@state() private failed = false;
	@state() private hasKey = false;
	@state() private inputChanged = false;

	protected createRenderRoot() {
		return this;
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.checkKeyStatus();
	}

	private async checkKeyStatus() {
		try {
			const key = await getAppStorage().providerKeys.get(this.provider);
			this.hasKey = !!key;
		} catch (error) {
			console.error("Failed to check key status:", error);
		}
	}

	private async testApiKey(provider: string, apiKey: string): Promise<boolean> {
		try {
			const preferred = PREFERRED_TEST_MODELS[provider];
			// Returning true here for Ollama and friends. Can' know which model to use for testing
			if (!preferred) return true;

			let model = resolveTestModel(provider, preferred);
			if (!model) return false;

			// Get proxy URL from settings (if available)
			const proxyEnabled = await getAppStorage().settings.get<boolean>("proxy.enabled");
			const proxyUrl = await getAppStorage().settings.get<string>("proxy.url");

			// Apply proxy only if this provider/key combination requires it
			model = applyProxyIfNeeded(model, apiKey, proxyEnabled ? proxyUrl || undefined : undefined);

			const context: Context = {
				messages: [{ role: "user", content: "Reply with: ok", timestamp: Date.now() }],
			};

			const result = await complete(model, context, {
				apiKey,
				maxTokens: 200,
			} as any);

			return result.stopReason === "stop";
		} catch (error) {
			console.error(`API key test failed for ${provider}:`, error);
			return false;
		}
	}

	private async saveKey() {
		if (!this.keyInput) return;

		this.testing = true;
		this.failed = false;

		const success = await this.testApiKey(this.provider, this.keyInput);

		this.testing = false;

		if (success) {
			try {
				await getAppStorage().providerKeys.set(this.provider, this.keyInput);
				this.hasKey = true;
				this.inputChanged = false;
				this.requestUpdate();
			} catch (error) {
				console.error("Failed to save API key:", error);
				this.failed = true;
				setTimeout(() => {
					this.failed = false;
					this.requestUpdate();
				}, 5000);
			}
		} else {
			this.failed = true;
			setTimeout(() => {
				this.failed = false;
				this.requestUpdate();
			}, 5000);
		}
	}

	render() {
		return html`
			<div class="space-y-3">
				<div class="flex items-center gap-2">
					<span class="text-sm font-medium capitalize text-foreground">${this.provider}</span>
					${
						this.testing
							? Badge({ children: i18n("Testing..."), variant: "secondary" })
							: this.hasKey
								? html`<span class="text-green-600 dark:text-green-400">✓</span>`
								: ""
					}
					${this.failed ? Badge({ children: i18n("✗ Invalid"), variant: "destructive" }) : ""}
				</div>
				<div class="flex items-center gap-2">
					${Input({
						type: "password",
						placeholder: this.hasKey ? "••••••••••••" : i18n("Enter API key"),
						value: this.keyInput,
						onInput: (e: Event) => {
							this.keyInput = (e.target as HTMLInputElement).value;
							this.inputChanged = true;
							this.requestUpdate();
						},
						className: "flex-1",
					})}
					${Button({
						onClick: () => this.saveKey(),
						variant: "default",
						size: "sm",
						disabled: !this.keyInput || this.testing || (this.hasKey && !this.inputChanged),
						children: i18n("Save"),
					})}
				</div>
			</div>
		`;
	}
}
