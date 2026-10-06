/**
 * PHI-VENDOR: start the Linux Xvfb virtual display for a browser launch.
 *
 * VirtualDisplay#get() is async (it waits for Xvfb to report its display number
 * on -displayfd). server.js used to call it without `await`, so the launch got
 * DISPLAY="[object Promise]" and Camoufox died with "cannot open display:
 * [object Promise]" on every Linux host; a missing Xvfb also surfaced as an
 * unhandled rejection instead of the intended headless fallback.
 *
 * Resolves { virtualDisplay, display } on success (display like ":99"), or
 * { virtualDisplay: null, display: undefined } when Xvfb is unavailable, in
 * which case the caller launches headless.
 */
export async function startVirtualDisplay(createVirtualDisplay, log, attempt) {
  let virtualDisplay = null;
  try {
    virtualDisplay = createVirtualDisplay();
    const display = await virtualDisplay.get();
    log('info', 'xvfb virtual display started', { display, attempt });
    return { virtualDisplay, display };
  } catch (err) {
    log('warn', 'xvfb not available, falling back to headless', { error: err.message, attempt });
    try {
      virtualDisplay?.kill?.();
    } catch {
      // best effort: get() already kills Xvfb when it fails to report a display
    }
    return { virtualDisplay: null, display: undefined };
  }
}
