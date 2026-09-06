/**
 * Theme Extension - /theme command
 *
 * Opens a selector with all available themes (built-in pack, custom themes,
 * extension-registered themes) and applies the choice immediately, persisted
 * to settings via the UI context's setTheme.
 */

import type { ExtensionAPI } from "phi-code";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("theme", {
		description: "Select the UI theme (built-in pack, custom, or extension themes)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Usage interactif uniquement. Sinon: définir \"theme\" dans settings.json.", "error");
				return;
			}
			const themes = ctx.ui.getAllThemes();
			const direct = args.trim();
			if (direct) {
				const found = themes.find((t) => t.name === direct);
				if (!found) {
					ctx.ui.notify(`Theme "${direct}" not found. Available: ${themes.map((t) => t.name).join(", ")}`, "error");
					return;
				}
				const result = ctx.ui.setTheme(found.name);
				ctx.ui.notify(result.success ? `Theme applied: ${found.name}` : `Theme error: ${result.error}`, result.success ? "info" : "error");
				return;
			}
			const choice = await ctx.ui.select(
				"Select theme",
				themes.map((t) => t.name),
			);
			if (!choice) return;
			const result = ctx.ui.setTheme(choice);
			ctx.ui.notify(result.success ? `Theme applied: ${choice}` : `Theme error: ${result.error}`, result.success ? "info" : "error");
		},
	});
}
