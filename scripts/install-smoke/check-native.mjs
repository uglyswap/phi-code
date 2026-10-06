#!/usr/bin/env node
// Usage (isolated env set by smoke.mjs): node check-native.mjs <runDir>
// Loads the native / heavy runtime dependencies from the place the INSTALLED
// code resolves them, and exercises each one (no network).
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { layout, result } from "./common.mjs";

const l = layout(process.argv[2]);
const checks = [];
async function check(label, fn, { optional = false } = {}) {
	try {
		const info = await fn();
		checks.push({ label, status: "PASS", info: info ?? "" });
	} catch (error) {
		const info = String(error?.stack ?? error).split("\n").slice(0, 3).join(" | ");
		checks.push({ label, status: optional ? "SKIP" : "FAIL", info });
	}
}
/** Directory of `name` as Node resolves it from `fromDir` (walking up node_modules). */
function pkgDir(fromDir, name) {
	let d = fromDir;
	for (;;) {
		const candidate = join(d, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (dirname(d) === d) throw new Error(`${name} not found from ${fromDir}`);
		d = dirname(d);
	}
}
const requireFrom = (dir) => createRequire(join(dir, "noop.cjs"));
const importFrom = (req, spec) => import(pathToFileURL(req.resolve(spec)).href);

const fromExt = requireFrom(join(l.agentDir, "extensions"));
const fromPhi = requireFrom(l.pkgDir);

await check("@ast-grep/napi (from agent/extensions)", async () => {
	const m = fromExt("@ast-grep/napi");
	const root = m.parse(m.Lang.TypeScript, "const a = 1").root();
	return `parse ok, root kind=${root.kind()}`;
});
await check("@silvia-odwyer/photon-node (from phi)", async () => {
	const m = fromPhi("@silvia-odwyer/photon-node");
	const img = new m.PhotonImage(new Uint8Array(4 * 2 * 2).fill(255), 2, 2);
	return `PhotonImage ${img.get_width()}x${img.get_height()}`;
});
await check("sigma-memory (from agent/extensions)", async () => {
	const m = await importFrom(fromExt, "sigma-memory");
	return `exports=${Object.keys(m).slice(0, 6).join(",")}`;
});
// realpath: the agent dir links (symlink/junction) to the installed packages,
// and Node resolves a package's own dependencies from its real location.
const sigmaDir = realpathSync(pkgDir(join(l.agentDir, "extensions"), "sigma-memory"));
const fromSigma = requireFrom(sigmaDir);
const fromTransformers = requireFrom(realpathSync(pkgDir(sigmaDir, "@huggingface/transformers")));
await check("@huggingface/transformers (from sigma-memory)", async () => {
	const m = await importFrom(fromSigma, "@huggingface/transformers");
	return `pipeline=${typeof (m.pipeline ?? m.default?.pipeline)}`;
});
await check("onnxruntime-node (from transformers)", async () => {
	const m = fromTransformers("onnxruntime-node");
	return `InferenceSession=${typeof m.InferenceSession}, backends ok`;
});
await check("sharp (from transformers)", async () => {
	const sharp = fromTransformers("sharp");
	const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } })
		.png()
		.toBuffer();
	return `libvips ${sharp.versions?.vips}, png ${png.length} bytes`;
});
await check("sql.js (from sigma-memory)", async () => {
	const init = fromSigma("sql.js");
	const SQL = await init();
	const db = new SQL.Database();
	return `select=${JSON.stringify(db.exec("select 1+1")[0].values)}`;
});
const browserDir = realpathSync(pkgDir(l.pkgDir, "@phi-code-admin/browser"));
const camoufoxDir = realpathSync(pkgDir(browserDir, "@phi-code-admin/camoufox-js"));
await check("better-sqlite3 (from camoufox-js)", async () => {
	const Db = requireFrom(camoufoxDir)("better-sqlite3");
	const db = new Db(":memory:");
	return `select=${JSON.stringify(db.prepare("select 1+1 as x").get())}`;
});
await check("@phi-code-admin/browser (from phi)", async () => {
	const m = await import(pathToFileURL(join(browserDir, "dist", "index.js")).href);
	return `exports=${Object.keys(m).join(",")}`;
});
await check("@phi-code-admin/camofox-browser (from browser)", async () => pkgDir(browserDir, "@phi-code-admin/camofox-browser"));
await check(
	"@mariozechner/clipboard (optional, from phi)",
	async () => `exports=${Object.keys(fromPhi("@mariozechner/clipboard")).slice(0, 4).join(",")}`,
	{ optional: true },
);
await check("phi-code-tui (from phi)", async () => `exports=${Object.keys(await importFrom(fromPhi, "phi-code-tui")).length}`);

for (const c of checks) console.log(`CHECK ${c.status} ${c.label}: ${c.info}`);
const failed = checks.filter((c) => c.status === "FAIL").map((c) => c.label);
result(failed.length ? "FAIL" : "PASS", failed.length ? `failed: ${failed.join(", ")}` : `${checks.length} native modules OK`);
