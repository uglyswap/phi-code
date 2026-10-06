import { TUI_KEYBINDINGS } from "phi-code-tui";
import { describe, expect, it } from "vitest";
import { KEYBINDINGS, useWindowsKeybindings } from "../src/core/keybindings.ts";

describe("fix-core #8372 Windows Terminal friendly keybinding defaults", () => {
	it("detects native Windows and WSL", () => {
		expect(useWindowsKeybindings("win32", {})).toBe(true);
		expect(useWindowsKeybindings("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
		expect(useWindowsKeybindings("linux", { WSL_INTEROP: "/run/WSL/1_interop" })).toBe(true);
		expect(useWindowsKeybindings("linux", {})).toBe(false);
		expect(useWindowsKeybindings("darwin", {})).toBe(false);
	});

	it("keeps phi's Tab Act/Plan toggle on every platform", () => {
		expect(KEYBINDINGS["app.mode.toggle"].defaultKeys).toBe("tab");
	});

	it("uses the platform defaults for the current process", () => {
		if (useWindowsKeybindings()) {
			expect(KEYBINDINGS["app.message.followUp"].defaultKeys).toBe("ctrl+q");
			expect(KEYBINDINGS["app.message.dequeue"].defaultKeys).toBe("alt+q");
			expect(KEYBINDINGS["app.model.cycleBackward"].defaultKeys).toBe("alt+p");
			expect(KEYBINDINGS["app.clipboard.pasteImage"].defaultKeys).toBe("alt+v");
			expect(KEYBINDINGS["tui.altScreen.previousPrompt"].defaultKeys).toBe("ctrl+up");
			expect(KEYBINDINGS["tui.altScreen.nextPrompt"].defaultKeys).toBe("ctrl+down");
			expect(KEYBINDINGS["tui.altScreen.search"].defaultKeys).toBe("ctrl+f");
			expect(KEYBINDINGS["tui.editor.undo"].defaultKeys).toBe(process.platform === "win32" ? "ctrl+z" : "alt+z");
		} else {
			expect(KEYBINDINGS["app.message.followUp"].defaultKeys).toBe("alt+enter");
			expect(KEYBINDINGS["app.message.dequeue"].defaultKeys).toBe("alt+up");
			expect(KEYBINDINGS["app.model.cycleBackward"].defaultKeys).toBe("shift+ctrl+p");
			expect(KEYBINDINGS["app.clipboard.pasteImage"].defaultKeys).toBe("ctrl+v");
			expect(KEYBINDINGS["tui.editor.undo"].defaultKeys).toEqual(TUI_KEYBINDINGS["tui.editor.undo"].defaultKeys);
		}
		// The model selector keeps alt+up for reordering on every platform.
		expect(KEYBINDINGS["app.models.reorderUp"].defaultKeys).toBe("alt+up");
	});
});
