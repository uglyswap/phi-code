/**
 * Security checks for messages coming out of sandboxed artifact/REPL iframes.
 *
 * The iframes run model-generated code with an opaque origin, but anything they
 * ask the host page to do runs with the app's origin, which holds the provider
 * API keys in IndexedDB. These helpers keep that boundary narrow.
 */

const EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Whether a URL requested by sandboxed code may be opened in a new window.
 * Only http(s) and mailto are allowed: a `javascript:` (or `data:`, `blob:`...)
 * URL opened by the host would execute in, or inherit, the app's origin.
 */
export function isSafeExternalUrl(url: unknown): url is string {
	if (typeof url !== "string") return false;
	try {
		return EXTERNAL_URL_PROTOCOLS.has(new URL(url).protocol);
	} catch {
		return false;
	}
}

/**
 * Whether a window `message` event may be routed to a sandbox's providers.
 * Accepted senders: the sandbox's own iframe, and the host window itself (it
 * relays sandbox errors with `window.postMessage`). Any other frame or window
 * that learned a sandbox ID (artifact IDs are predictable) is ignored.
 */
export function isTrustedSandboxSource(
	source: MessageEventSource | null,
	sandboxWindow: Window | null | undefined,
	hostWindow: Window,
): boolean {
	if (source === null) return false;
	if (source === hostWindow) return true;
	return sandboxWindow != null && source === sandboxWindow;
}
