import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Whether this machine can create symlinks.
 *
 * Windows refuses `symlink()` with EPERM unless the process is elevated or the
 * account has SeCreateSymbolicLinkPrivilege (Developer Mode). Probing once keeps
 * the symlink cases running wherever they can, instead of hard-skipping win32.
 */
export const symlinkSupported: boolean = (() => {
	const probe = mkdtempSync(join(tmpdir(), "phi-symlink-probe-"));
	try {
		writeFileSync(join(probe, "target.txt"), "probe");
		symlinkSync(join(probe, "target.txt"), join(probe, "link.txt"));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();
