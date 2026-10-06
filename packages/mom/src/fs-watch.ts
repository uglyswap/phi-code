import { type FSWatcher, type WatchListener, watch } from "node:fs";

// Ported from upstream pi f3a2c9d05 (#3564): an `fs.watch` watcher emits
// asynchronous "error" events (EMFILE, ENOSPC, directory removed...). Without a
// listener Node turns them into an uncaught exception that kills mom.
export const FS_WATCH_RETRY_DELAY_MS = 5000;

export function closeWatcher(watcher: FSWatcher | null | undefined): void {
	if (!watcher) {
		return;
	}

	try {
		watcher.close();
	} catch {
		// Closing an already-failed watcher can throw; the watcher is discarded either way.
	}
}

export function watchWithErrorHandler(
	path: string,
	listener: WatchListener<string>,
	onError: (error: unknown) => void,
): FSWatcher | null {
	try {
		const watcher = watch(path, listener);
		watcher.on("error", onError);
		return watcher;
	} catch (error) {
		onError(error);
		return null;
	}
}
