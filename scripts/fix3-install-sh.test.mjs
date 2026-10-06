// Regression test for scripts/install.sh updating an existing install: files
// must be replaced with new inodes (unlink + copy), never rewritten in place,
// because a running phi maps the native modules shipped in node_modules.
// uname and curl are replaced by shims serving a locally built archive.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "install.sh");
const HAS_SH = spawnSync("sh", ["-c", "command -v tar && command -v sha256sum || command -v shasum"], { stdio: "ignore" }).status === 0;

function write(file, content) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

// Converts C:\x\y to /c/x/y for MSYS shells; POSIX paths are returned as is.
const shPath = (p) => (process.platform === "win32" ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, "/") : p);

test("install.sh replaces native modules with new inodes", { skip: !HAS_SH }, () => {
	const root = mkdtempSync(join(tmpdir(), "fix3-install-sh-"));
	try {
		const archiveSrc = join(root, "archive");
		write(join(archiveSrc, "phi", "phi"), "#!/bin/sh\necho 9.9.9\n");
		write(join(archiveSrc, "phi", "package.json"), "{}");
		write(join(archiveSrc, "phi", "node_modules", "onnx", "lib.so"), "new-lib");
		const serve = join(root, "serve");
		mkdirSync(serve);
		const tarball = join(serve, "phi-linux-x64.tar.gz");
		const tar = spawnSync("tar", ["-czf", shPath(tarball), "-C", shPath(archiveSrc), "phi"], { encoding: "utf8", shell: false });
		assert.equal(tar.status, 0, tar.stderr);
		const sum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
		writeFileSync(join(serve, "SHA256SUMS"), `${sum}  phi-linux-x64.tar.gz\n`);

		const bin = join(root, "bin");
		write(join(bin, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac\n');
		// curl -fsSL <url> -o <file>: copy the URL's basename from the serve dir.
		write(join(bin, "curl"), `#!/bin/sh\nurl="$2"; out="$4"\ncp "${shPath(serve)}/\${url##*/}" "$out"\n`);
		chmodSync(join(bin, "uname"), 0o755);
		chmodSync(join(bin, "curl"), 0o755);

		const installRoot = join(root, "share", "phi");
		const oldLib = join(installRoot, "node_modules", "onnx", "lib.so");
		write(oldLib, "old-lib");
		// Second name for the old inode: an in-place rewrite would change it too.
		linkSync(oldLib, join(root, "old-lib-inode"));

		const result = spawnSync("sh", [shPath(SCRIPT)], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${shPath(bin)}:${process.env.PATH}`,
				PHI_INSTALL_ROOT: shPath(installRoot),
				PHI_INSTALL_DIR: shPath(join(root, "bin-out")),
			},
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal(readFileSync(oldLib, "utf8"), "new-lib");
		assert.equal(readFileSync(join(root, "old-lib-inode"), "utf8"), "old-lib", "old inode must be left untouched");
		assert.equal(readFileSync(join(installRoot, "phi"), "utf8"), "#!/bin/sh\necho 9.9.9\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
