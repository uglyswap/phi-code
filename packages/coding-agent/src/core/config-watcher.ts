/**
 * Config file watcher - debounced fs.watch wrapper for ~/.phi/agent/*.json.
 *
 * Per Q5 + Q9: emits "<file>_changed" events when models.json or routing.json
 * are modified on disk. Debounced 300ms to coalesce burst writes (atomic
 * tmp+rename produces multiple fs events).
 *
 * Cross-platform: fs.watch is available on Linux/macOS/Windows. On some
 * Windows file systems, fs.watch may fire repeated events; the debounce
 * absorbs them.
 *
 * Events emitted via EventEmitter:
 *   - "models_json_changed"   : ~/.phi/agent/models.json changed
 *   - "routing_json_changed"  : ~/.phi/agent/routing.json changed
 *   - "watcher_error"         : underlying fs.watch error
 *
 * The watcher silently skips files that don't exist when start() is called.
 * Re-call start() after the file is created to begin watching it.
 */

import { EventEmitter } from "node:events";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

interface WatchedFile {
	path: string;
	eventName: string;
	watcher: FSWatcher | null;
	debounceTimer: NodeJS.Timeout | null;
	ignoreUntil: number;
}

export class ConfigWatcher extends EventEmitter {
	private files: WatchedFile[] = [];
	private debounceMs: number;

	constructor(options?: { debounceMs?: number; agentDir?: string }) {
		super();
		this.debounceMs = options?.debounceMs ?? 300;
		const agentDir = options?.agentDir ?? join(homedir(), ".phi", "agent");
		this.files = [
			{
				path: join(agentDir, "models.json"),
				eventName: "models_json_changed",
				watcher: null,
				debounceTimer: null,
				ignoreUntil: 0,
			},
			{
				path: join(agentDir, "routing.json"),
				eventName: "routing_json_changed",
				watcher: null,
				debounceTimer: null,
				ignoreUntil: 0,
			},
		];
	}

	/**
	 * Start watching all configured files (no-op for files that don't exist).
	 */
	start(): void {
		for (const file of this.files) {
			this.startWatching(file);
		}
	}

	/**
	 * Stop all watchers and clear pending debounces.
	 */
	stop(): void {
		for (const file of this.files) {
			if (file.watcher) {
				try {
					file.watcher.close();
				} catch {
					// ignore close errors
				}
				file.watcher = null;
			}
			if (file.debounceTimer) {
				clearTimeout(file.debounceTimer);
				file.debounceTimer = null;
			}
		}
	}

	/**
	 * Tell the watcher to ignore the next change event for a file (used right
	 * after programmatic write to avoid echoing it back to ourselves).
	 * The ignore window is debounceMs * 2.
	 */
	muteForWrite(eventName: string): void {
		const file = this.files.find((f) => f.eventName === eventName);
		if (!file) return;
		file.ignoreUntil = Date.now() + this.debounceMs * 2;
	}

	private startWatching(file: WatchedFile): void {
		if (file.watcher) return;
		const parentDir = dirname(file.path);
		const fileName = basename(file.path);

		// Watch the parent directory so we catch atomic rename (tmp -> file).
		// Some platforms emit on the parent when a file is created/renamed.
		if (!existsSync(parentDir)) {
			return;
		}

		try {
			const watcher = watch(parentDir, { persistent: false }, (_eventType, changedName) => {
				if (changedName !== fileName) return;
				this.scheduleEmit(file);
			});
			watcher.on("error", (err) => {
				this.emit("watcher_error", { path: file.path, error: err });
			});
			file.watcher = watcher;
		} catch (err) {
			this.emit("watcher_error", { path: file.path, error: err });
		}
	}

	private scheduleEmit(file: WatchedFile): void {
		if (Date.now() < file.ignoreUntil) return;
		if (file.debounceTimer) clearTimeout(file.debounceTimer);
		file.debounceTimer = setTimeout(() => {
			file.debounceTimer = null;
			this.emit(file.eventName, { path: file.path });
		}, this.debounceMs);
	}
}

let _singleton: ConfigWatcher | null = null;
export function getConfigWatcher(options?: ConstructorParameters<typeof ConfigWatcher>[0]): ConfigWatcher {
	if (!_singleton) {
		_singleton = new ConfigWatcher(options);
	}
	return _singleton;
}

export function _resetConfigWatcher(): void {
	if (_singleton) _singleton.stop();
	_singleton = null;
}
