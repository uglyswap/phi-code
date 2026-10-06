import assert from "node:assert/strict";
import { test } from "node:test";
import { getPublicWorkspacePackages, orderByInternalDependencies } from "./release-packages.mjs";

test("internal dependencies are published before their dependents", () => {
	const ordered = orderByInternalDependencies(getPublicWorkspacePackages()).map((pkg) => pkg.name);
	const before = (a, b) => assert.ok(ordered.indexOf(a) < ordered.indexOf(b), `${a} must precede ${b}`);
	before("phi-code-ai", "phi-code-agent");
	before("phi-code-tui", "@phi-code-admin/phi-code");
	before("sigma-memory", "@phi-code-admin/phi-code");
	before("@phi-code-admin/camoufox-js", "@phi-code-admin/camofox-browser");
	before("@phi-code-admin/camofox-browser", "@phi-code-admin/browser");
	before("@phi-code-admin/browser", "@phi-code-admin/phi-code");
	before("@phi-code-admin/phi-code", "@phi-code-admin/mom");
});

test("a dependency cycle is reported", () => {
	const manifests = { a: { dependencies: { b: "1" } }, b: { dependencies: { a: "1" } } };
	assert.throws(
		() => orderByInternalDependencies([{ name: "a" }, { name: "b" }], (pkg) => manifests[pkg.name]),
		/cycle: a -> b -> a/,
	);
});
