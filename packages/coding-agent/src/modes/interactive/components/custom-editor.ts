import { Editor, type EditorOptions, type EditorTheme, type TUI } from "phi-code-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.js";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Mode toggle (Tab) - only when the editor is empty and autocomplete is not
		// showing, so Tab keeps triggering completion / acceptance while the user types.
		if (this.keybindings.matches(data, "app.mode.toggle")) {
			if (this.getText().trim().length === 0 && !this.isShowingAutocomplete()) {
				const handler = this.actionHandlers.get("app.mode.toggle");
				if (handler) {
					handler();
					return;
				}
			}
			// Otherwise fall through to the parent editor (Tab completion / accept).
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (
				action !== "app.interrupt" &&
				action !== "app.exit" &&
				action !== "app.mode.toggle" &&
				this.keybindings.matches(data, action)
			) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
