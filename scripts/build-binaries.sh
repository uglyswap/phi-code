#!/usr/bin/env bash
#
# Build phi binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-install] [--skip-deps] [--skip-build] [--skip-extension-deps] [--offline-model-data] [--platform <platform>] [--out <dir>]
#
# Options:
#   --skip-install       Skip npm ci
#   --skip-deps          Skip installing cross-platform dependencies
#   --skip-build         Skip the package build
#   --skip-extension-deps Do not ship the bundled extensions' npm dependencies
#                        (sigma-*, MCP SDK, zod, ...): smaller archives, but the
#                        memory/agents/skills/mcp/ast-grep/lsp/browser extensions fail to load
#   --offline-model-data Build with bundled model data instead of refreshing it
#   --platform <name>    Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
#   --out <dir>          Output directory (default: packages/coding-agent/binaries)
#   --prune-extension-deps <dir>
#                        Only prune an already staged extension dependency
#                        prefix (<dir>/package.json + <dir>/node_modules) for
#                        --platform, then exit (used by the tests)
#
# Output:
#   packages/coding-agent/binaries/
#     phi-darwin-arm64.tar.gz
#     phi-darwin-x64.tar.gz
#     phi-linux-x64.tar.gz
#     phi-linux-arm64.tar.gz
#     phi-windows-x64.zip
#     phi-windows-arm64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_INSTALL=false
SKIP_DEPS=false
SKIP_BUILD=false
SKIP_EXTENSION_DEPS=false
OFFLINE_MODEL_DATA=false
PLATFORM=""
OUTPUT_DIR=""
PRUNE_ONLY_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --skip-extension-deps)
            SKIP_EXTENSION_DEPS=true
            shift
            ;;
        --offline-model-data)
            OFFLINE_MODEL_DATA=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --prune-extension-deps)
            PRUNE_ONLY_DIR="$2"
            shift 2
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="packages/coding-agent/binaries"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

# Shrink the extension dependencies staged for one target platform (prefix
# $2 holding package.json + node_modules) without losing a runtime feature.
# Unpruned, they weigh ~430 MB, mostly onnxruntime-node's binaries for every
# OS (sigma-memory -> @huggingface/transformers). Every rule is explicit and
# checked; the build fails when an expected native binary or entry file is
# missing, or when an assumption behind a rule no longer holds:
#   - onnxruntime-node: keep only bin/napi-v3/<os>/<arch>.
#   - onnxruntime-web: dropped. transformers' Node builds (the "node" export
#     condition, used by Node and Bun) mark it "(ignored)"; only the browser
#     build imports it. Checked below on the shipped Node entry files.
#   - tar, global-agent: only onnxruntime-node's postinstall downloader
#     (script/install.js) uses them, and install scripts never run here.
#   - @phi-code-admin/camofox-browser, @phi-code-admin/camoufox-js: the
#     browser server runs under the system Node (native modules built for its
#     ABI); @phi-code-admin/browser installs it with npm on first use.
#   - packages unreachable from the declared dependencies once those edges are
#     cut (onnxruntime-web's own tree), or built for another os/cpu/libc.
#   - @huggingface/transformers/dist and sql.js/dist: keep only the files
#     their package.json "exports" select in Node (+ sql-wasm.wasm).
#   - every package except sigma-*: source maps, .d.ts and .tsbuildinfo.
#   - linux: libonnxruntime.so.1 is a byte copy of libonnxruntime.so.1.<ver>
#     in the npm tarball (a symlink upstream); restored as a symlink.
prune_extension_deps() {
    local platform="$1"
    local staging="$2"
    node - "$platform" "$staging" <<'PRUNE_EXTENSION_DEPS'
const fs = require("fs");
const path = require("path");

const [platform, staging] = process.argv.slice(2);
const fail = (message) => {
    console.error(`prune-extension-deps (${platform}): ${message}`);
    process.exit(1);
};
const OS = { darwin: "darwin", linux: "linux", windows: "win32" }[platform.split("-")[0]];
const ARCH = platform.split("-")[1];
const LIBC = OS === "linux" ? "glibc" : undefined;
if (!OS || !ARCH) fail("unknown platform");
const nodeModules = path.join(staging, "node_modules");
if (!fs.existsSync(nodeModules)) fail(`${nodeModules} does not exist`);

// Native packages the target needs: missing ones fail the build.
const NATIVE_PACKAGES = {
    "darwin-arm64": ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64", "@ast-grep/napi-darwin-arm64"],
    "darwin-x64": ["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64", "@ast-grep/napi-darwin-x64"],
    "linux-x64": ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64", "@ast-grep/napi-linux-x64-gnu"],
    "linux-arm64": ["@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64", "@ast-grep/napi-linux-arm64-gnu"],
    "windows-x64": ["@img/sharp-win32-x64", "@ast-grep/napi-win32-x64-msvc"],
    "windows-arm64": ["@img/sharp-win32-arm64", "@ast-grep/napi-win32-arm64-msvc"],
}[platform];
if (!NATIVE_PACKAGES) fail("no native package list for this platform");
// Dependency edges never followed at runtime (see the comment above).
const DROPPED_PACKAGES = new Set(["onnxruntime-web"]);
const DROPPED_EDGES = {
    "onnxruntime-node": new Set(["tar", "global-agent"]),
    // The camofox-browser server runs under the system Node with native
    // modules built for it: @phi-code-admin/browser installs it on first use
    // (packages/browser/src/server-runtime.ts). Checked below.
    "@phi-code-admin/browser": new Set(["@phi-code-admin/camofox-browser", "@phi-code-admin/camoufox-js"]),
};
// Imports a package makes without declaring them (resolved through hoisting).
const UNDECLARED_EDGES = { "@huggingface/transformers": ["onnxruntime-common"] };

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const rm = (target) => fs.rmSync(target, { recursive: true, force: true });

// All installed package directories, nested node_modules included.
function listPackages(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(".")) continue;
        const full = path.join(dir, entry);
        if (entry.startsWith("@")) {
            for (const scoped of fs.readdirSync(full)) {
                const pkgDir = path.join(full, scoped);
                out.push(pkgDir);
                listPackages(path.join(pkgDir, "node_modules"), out);
            }
        } else {
            out.push(full);
            listPackages(path.join(full, "node_modules"), out);
        }
    }
    return out;
}

// Node's lookup: <dir>/node_modules/<name>, then each parent up to staging.
function resolvePackage(name, fromDir) {
    let dir = fromDir;
    for (;;) {
        const candidate = path.join(dir, "node_modules", name);
        if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
        if (path.resolve(dir) === path.resolve(staging)) return undefined;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = path.basename(parent) === "node_modules" ? path.dirname(parent) : parent;
        if (path.basename(dir).startsWith("@")) dir = path.dirname(path.dirname(dir));
    }
}

function matchesTarget(pkg) {
    const allows = (list, value) => {
        if (!Array.isArray(list) || list.length === 0 || value === undefined) return true;
        if (list.includes(`!${value}`)) return false;
        const positive = list.filter((entry) => !entry.startsWith("!"));
        return positive.length === 0 || positive.includes(value);
    };
    return allows(pkg.os, OS) && allows(pkg.cpu, ARCH) && allows(pkg.libc, LIBC);
}

function checkAssumptions() {
    const transformersDir = path.join(nodeModules, "@huggingface", "transformers");
    const entries = transformersNodeEntries(transformersDir);
    for (const entry of entries) {
        const source = fs.readFileSync(path.join(transformersDir, entry), "utf8");
        if (/(?:from\s*|require\(\s*|import\(\s*)["']onnxruntime-web["']/.test(source)) {
            fail(`${entry} now imports onnxruntime-web: it can no longer be dropped`);
        }
    }
    // @phi-code-admin/browser may only locate the server (require.resolve),
    // never load it: it is not shipped, but installed on first use.
    if (readJson(path.join(staging, "package.json")).dependencies?.["@phi-code-admin/browser"]) {
        const browserDist = path.join(nodeModules, "@phi-code-admin", "browser", "dist");
        if (!fs.existsSync(path.join(browserDist, "server-runtime.js"))) {
            fail("@phi-code-admin/browser has no dist/server-runtime.js: it cannot install its server on first use");
        }
        for (const file of fs.readdirSync(browserDist).filter((f) => f.endsWith(".js"))) {
            const source = fs.readFileSync(path.join(browserDist, file), "utf8");
            if (/(?:from\s*|require\(\s*|import\(\s*)["']@phi-code-admin\/camou?fox-/.test(source)) {
                fail(`@phi-code-admin/browser/dist/${file} loads the camofox server packages: they can no longer be dropped`);
            }
        }
    }
    const ortDist = path.join(nodeModules, "onnxruntime-node", "dist");
    for (const file of fs.readdirSync(ortDist).filter((f) => f.endsWith(".js"))) {
        const source = fs.readFileSync(path.join(ortDist, file), "utf8");
        if (/require\(\s*["'](?:tar|global-agent)["']\s*\)/.test(source)) {
            fail(`onnxruntime-node/dist/${file} now requires tar/global-agent at runtime`);
        }
    }
}

function transformersNodeEntries(transformersDir) {
    const pkgFile = path.join(transformersDir, "package.json");
    if (!fs.existsSync(pkgFile)) fail("@huggingface/transformers is not installed");
    const node = readJson(pkgFile).exports?.node;
    const entries = [node?.import?.default, node?.require?.default].filter((entry) => typeof entry === "string");
    if (entries.length === 0) fail("@huggingface/transformers has no exports.node entry");
    for (const entry of entries) {
        if (!fs.existsSync(path.join(transformersDir, entry))) fail(`@huggingface/transformers/${entry} is missing`);
    }
    return entries.map((entry) => path.normalize(entry));
}

function pruneUnreachable() {
    const keep = new Set();
    const queue = [];
    const visit = (name, fromDir, required) => {
        if (DROPPED_PACKAGES.has(name)) return;
        const dir = resolvePackage(name, fromDir);
        if (!dir) {
            if (required) fail(`dependency ${name} (from ${path.relative(staging, fromDir) || "root"}) is not installed`);
            return;
        }
        if (keep.has(dir)) return;
        if (!matchesTarget(readJson(path.join(dir, "package.json")))) return;
        keep.add(dir);
        queue.push(dir);
    };
    const root = readJson(path.join(staging, "package.json"));
    for (const name of Object.keys(root.dependencies || {})) visit(name, staging, true);
    while (queue.length > 0) {
        const dir = queue.shift();
        const pkg = readJson(path.join(dir, "package.json"));
        const dropped = DROPPED_EDGES[pkg.name] || new Set();
        const follow = (deps, required) => {
            for (const name of Object.keys(deps || {})) if (!dropped.has(name)) visit(name, dir, required);
        };
        follow(pkg.dependencies, true);
        follow(pkg.optionalDependencies, false);
        follow(pkg.peerDependencies, false);
        for (const name of UNDECLARED_EDGES[pkg.name] || []) visit(name, dir, true);
    }
    const removed = [];
    for (const dir of listPackages(nodeModules)) {
        if (keep.has(dir) || !fs.existsSync(dir)) continue;
        // A kept package nested below a removed one cannot exist: resolution
        // only walks up, so its parent was visited first.
        removed.push(path.relative(nodeModules, dir).split(path.sep).join("/"));
        rm(dir);
    }
    for (const scope of fs.readdirSync(nodeModules).filter((e) => e.startsWith("@"))) {
        const scopeDir = path.join(nodeModules, scope);
        if (fs.readdirSync(scopeDir).length === 0) rm(scopeDir);
    }
    console.log(`Removed ${removed.length} packages not loaded at runtime: ${removed.join(", ")}`);
}

function pruneOnnxruntimeNode() {
    const napiDir = path.join(nodeModules, "onnxruntime-node", "bin", "napi-v3");
    const target = path.join(napiDir, OS, ARCH);
    if (!fs.existsSync(path.join(target, "onnxruntime_binding.node"))) {
        fail(`onnxruntime-node has no binding for ${OS}/${ARCH}`);
    }
    for (const os of fs.readdirSync(napiDir)) {
        if (os !== OS) {
            rm(path.join(napiDir, os));
            continue;
        }
        for (const arch of fs.readdirSync(path.join(napiDir, os))) if (arch !== ARCH) rm(path.join(napiDir, os, arch));
    }
    if (OS === "linux") {
        const versioned = fs.readdirSync(target).find((f) => /^libonnxruntime\.so\.\d+\.\d+\.\d+$/.test(f));
        const soname = path.join(target, "libonnxruntime.so.1");
        if (versioned && fs.existsSync(soname) && !fs.lstatSync(soname).isSymbolicLink()) {
            const a = fs.readFileSync(soname);
            const b = fs.readFileSync(path.join(target, versioned));
            if (a.equals(b)) {
                rm(soname);
                try {
                    fs.symlinkSync(versioned, soname);
                } catch (error) {
                    // Only reachable when staging a linux target on a host
                    // without symlink support (Windows without privilege).
                    console.warn(`Keeping a copy of libonnxruntime.so.1: ${error.message}`);
                    fs.writeFileSync(soname, a);
                }
            }
        }
    }
}

function keepOnly(dir, keepFiles, label) {
    for (const file of keepFiles) if (!fs.existsSync(path.join(dir, file))) fail(`${label}/${file} is missing`);
    for (const file of fs.readdirSync(dir)) if (!keepFiles.includes(file)) rm(path.join(dir, file));
}

function pruneEntryVariants() {
    const transformersDir = path.join(nodeModules, "@huggingface", "transformers");
    const entries = transformersNodeEntries(transformersDir);
    if (!entries.every((entry) => path.dirname(entry) === "dist")) fail("transformers Node entries moved out of dist/");
    keepOnly(path.join(transformersDir, "dist"), entries.map((entry) => path.basename(entry)), "@huggingface/transformers/dist");

    const sqlDir = path.join(nodeModules, "sql.js");
    const sqlEntry = readJson(path.join(sqlDir, "package.json")).exports?.["."]?.default;
    if (typeof sqlEntry !== "string" || path.dirname(path.normalize(sqlEntry)) !== "dist") fail("sql.js exports changed");
    const sqlJs = path.basename(sqlEntry);
    // sql-wasm.js loads the .wasm with the same basename from its own directory.
    keepOnly(path.join(sqlDir, "dist"), [sqlJs, sqlJs.replace(/\.js$/, ".wasm")], "sql.js/dist");
}

function pruneDevFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (/^sigma-/.test(entry.name) && path.basename(dir) === "node_modules") continue;
            pruneDevFiles(full);
        } else if (/\.(?:map|d\.ts|d\.mts|d\.cts|tsbuildinfo)$/.test(entry.name)) {
            rm(full);
        }
    }
}

function checkNativePackages() {
    const isNative = (name) => /\.(?:node|dll|dylib|so(?:\.\d+)*)$/.test(name);
    const hasNative = (dir) =>
        fs.readdirSync(dir, { withFileTypes: true }).some((e) => (e.isDirectory() ? hasNative(path.join(dir, e.name)) : isNative(e.name)));
    for (const name of NATIVE_PACKAGES) {
        const dir = path.join(nodeModules, name);
        if (!fs.existsSync(dir) || !hasNative(dir)) fail(`native package ${name} is missing`);
    }
}

checkAssumptions();
pruneUnreachable();
pruneOnnxruntimeNode();
pruneEntryVariants();
pruneDevFiles(nodeModules);
checkNativePackages();
PRUNE_EXTENSION_DEPS
}

if [[ -n "$PRUNE_ONLY_DIR" ]]; then
    if [[ -z "$PLATFORM" ]]; then
        echo "--prune-extension-deps requires --platform"
        exit 1
    fi
    prune_extension_deps "$PLATFORM" "$PRUNE_ONLY_DIR"
    exit 0
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    npm ci --ignore-scripts
else
    echo "==> Skipping npm ci (--skip-install)"
fi

if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Installing cross-platform native bindings..."
    CLIPBOARD_VERSION=$(node -p "require('./packages/coding-agent/package.json').optionalDependencies['@mariozechner/clipboard']")
    # npm ci only installs optional deps for the current platform. Install the
    # cross-platform packages in isolation so npm does not re-resolve and mutate
    # the workspace dependency graph, which can trigger npm/arborist failures.
    NATIVE_DEPS_DIR=$(mktemp -d)
    cleanup_native_deps() {
        rm -rf "$NATIVE_DEPS_DIR"
    }
    trap cleanup_native_deps EXIT
    printf '%s\n' '{"private":true}' > "$NATIVE_DEPS_DIR/package.json"
    # Use --force to bypass platform checks (os/cpu restrictions in package.json).
    npm install --prefix "$NATIVE_DEPS_DIR" --include=optional --no-save --package-lock=false --force --ignore-scripts \
        @mariozechner/clipboard@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-darwin-arm64@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-darwin-x64@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-linux-x64-gnu@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-linux-arm64-gnu@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-win32-x64-msvc@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-win32-arm64-msvc@"$CLIPBOARD_VERSION"
    mkdir -p node_modules/@mariozechner
    for package in \
        clipboard \
        clipboard-darwin-arm64 \
        clipboard-darwin-x64 \
        clipboard-linux-x64-gnu \
        clipboard-linux-arm64-gnu \
        clipboard-win32-x64-msvc \
        clipboard-win32-arm64-msvc; do
        rm -rf "node_modules/@mariozechner/$package"
        cp -R "$NATIVE_DEPS_DIR/node_modules/@mariozechner/$package" node_modules/@mariozechner/
    done
    cleanup_native_deps
    trap - EXIT
else
    echo "==> Skipping cross-platform native bindings (--skip-deps)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    if [[ "$OFFLINE_MODEL_DATA" == "true" ]]; then
        echo "==> Building all packages with bundled model data..."
        npm run build:offline
    else
        echo "==> Building all packages..."
        npm run build
    fi
else
    echo "==> Skipping package build (--skip-build)"
fi

echo "==> Building binaries..."
cd packages/coding-agent

# Clean previous builds
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    bun_target="bun-$platform"
    if [[ "$platform" == *-x64 ]]; then
        bun_target="${bun_target}-baseline"
    fi

    # Bun compiled executables only embed worker scripts when they are passed as
    # explicit build entrypoints. The runtime can still use new URL(...), but the
    # worker must be present in the compiled executable.
    #
    # Disable cwd bunfig.toml autoload so project preload scripts cannot crash the
    # standalone binary before pi starts (see #7684).
    #
    # --compile-autoload-package-json: without it (Bun's default for compiled
    # executables), the runtime resolver ignores package.json files on disk, so
    # a module loaded natively from the archive's node_modules cannot import
    # its own dependencies ("Cannot find package 'onnxruntime-common'", sharp ->
    # detect-libc, MCP SDK -> ajv). Checked with Bun 1.3.14 and 1.4.2.
    if [[ "$platform" == windows-* ]]; then
        bun build --compile --no-compile-autoload-bunfig --compile-autoload-package-json --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile "$OUTPUT_DIR/$platform/phi.exe"
    else
        bun build --compile --no-compile-autoload-bunfig --compile-autoload-package-json --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile "$OUTPUT_DIR/$platform/phi"
    fi
done

# Bundled phi extensions import npm packages that are not embedded in the
# executable (only typebox and phi-code* are, via the loader's virtual modules).
# Keep this list in sync with BUNDLED_EXTENSION_DEPS in src/core/bundled-assets.ts
# and extensionDeps in scripts/postinstall.cjs.
EXTENSION_DEPS=(sigma-memory sigma-agents sigma-skills zod @modelcontextprotocol/sdk @ast-grep/napi cross-spawn ignore @phi-code-admin/browser)
# Workspace packages (directories under packages/) are packed from the local
# build so the archive ships the exact code this release was built from
# (the build has built their dist/).
EXTENSION_WORKSPACE_DIRS=(sigma-memory sigma-agents sigma-skills browser)
EXTENSION_TARBALLS_DIR=""
if [[ "$SKIP_EXTENSION_DEPS" == "false" ]]; then
    echo "==> Packing workspace extension dependencies..."
    EXTENSION_TARBALLS_DIR=$(mktemp -d)
    for package_dir in "${EXTENSION_WORKSPACE_DIRS[@]}"; do
        (cd "../$package_dir" && npm pack --ignore-scripts --pack-destination "$EXTENSION_TARBALLS_DIR" >/dev/null)
    done
fi

# Install the extension dependencies for one target platform into a staging
# prefix. --os/--cpu make npm pick the target's native optional packages
# (@ast-grep/napi-*, sharp's @img/*) instead of the build host's. Install
# scripts are skipped: onnxruntime-node already ships its CPU binaries for every
# platform in its tarball.
stage_extension_deps() {
    local platform="$1"
    local staging="$2"
    local npm_os=""
    local npm_cpu="${platform##*-}"
    case "$platform" in
        darwin-*) npm_os="darwin" ;;
        linux-*) npm_os="linux" ;;
        windows-*) npm_os="win32" ;;
    esac
    # Versions come from packages/coding-agent/package.json; workspace packages
    # point at the tarballs packed above.
    PHI_EXT_TARBALLS_DIR="$EXTENSION_TARBALLS_DIR" PHI_EXT_STAGING="$staging" node -e '
        const fs = require("fs");
        const path = require("path");
        const pkg = require("./package.json");
        const deps = { ...pkg.optionalDependencies, ...pkg.dependencies };
        const tarballDir = process.env.PHI_EXT_TARBALLS_DIR;
        const tarballs = fs.readdirSync(tarballDir);
        const out = {};
        for (const name of process.argv.slice(1)) {
            const prefix = name.replace(/^@/, "").replace(/\//g, "-") + "-";
            const tarball = tarballs.find((f) => f.startsWith(prefix) && /^\d/.test(f.slice(prefix.length)) && f.endsWith(".tgz"));
            if (tarball) out[name] = "file:" + path.join(tarballDir, tarball);
            else if (deps[name]) out[name] = deps[name];
            else throw new Error("No version for bundled extension dependency " + name + " in packages/coding-agent/package.json");
        }
        fs.writeFileSync(path.join(process.env.PHI_EXT_STAGING, "package.json"), JSON.stringify({ private: true, dependencies: out }, null, 2));
    ' "${EXTENSION_DEPS[@]}"
    # Linux releases target glibc (Bun's linux builds). Without --libc, npm uses
    # the build host's libc and, on a non-Linux host, skips every libc-tagged
    # package (@ast-grep/napi-linux-*-gnu, @img/sharp-linux-*).
    local libc_args=()
    if [[ "$npm_os" == "linux" ]]; then
        libc_args=(--libc=glibc)
    fi
    npm install --prefix "$staging" --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false \
        --os="$npm_os" --cpu="$npm_cpu" ${libc_args[@]+"${libc_args[@]}"}
}

echo "==> Creating release archives..."

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json "$OUTPUT_DIR/$platform/"
    cp README.md "$OUTPUT_DIR/$platform/"
    cp CHANGELOG.md "$OUTPUT_DIR/$platform/"
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "$OUTPUT_DIR/$platform/"
    mkdir -p "$OUTPUT_DIR/$platform/theme"
    cp dist/modes/interactive/theme/*.json "$OUTPUT_DIR/$platform/theme/"
    # Extended built-in theme pack: theme.ts reads <themes dir>/defaults/*.json.
    mkdir -p "$OUTPUT_DIR/$platform/theme/defaults"
    cp dist/modes/interactive/theme/defaults/*.json "$OUTPUT_DIR/$platform/theme/defaults/"
    # Bundled phi extensions ship as TypeScript sources loaded at runtime; stage
    # them next to the executable, where getPackageDir() points in a Bun binary.
    mkdir -p "$OUTPUT_DIR/$platform/extensions"
    cp -r extensions/phi "$OUTPUT_DIR/$platform/extensions/"
    # Bundled agents and skills: copied into the agent dir on first start, like
    # postinstall.cjs does for npm installs (src/core/bundled-assets.ts).
    cp -r agents "$OUTPUT_DIR/$platform/"
    cp -r skills "$OUTPUT_DIR/$platform/"
    mkdir -p "$OUTPUT_DIR/$platform/assets"
    cp dist/modes/interactive/assets/* "$OUTPUT_DIR/$platform/assets/"
    cp -r dist/core/export-html "$OUTPUT_DIR/$platform/"
    cp -r docs "$OUTPUT_DIR/$platform/"
    cp -r examples "$OUTPUT_DIR/$platform/"

    case "$platform" in
        darwin-arm64)
            clipboard_native_package="clipboard-darwin-arm64"
            clipboard_native_file="clipboard.darwin-arm64.node"
            ;;
        darwin-x64)
            clipboard_native_package="clipboard-darwin-x64"
            clipboard_native_file="clipboard.darwin-x64.node"
            ;;
        linux-x64)
            clipboard_native_package="clipboard-linux-x64-gnu"
            clipboard_native_file="clipboard.linux-x64-gnu.node"
            ;;
        linux-arm64)
            clipboard_native_package="clipboard-linux-arm64-gnu"
            clipboard_native_file="clipboard.linux-arm64-gnu.node"
            ;;
        windows-x64)
            clipboard_native_package="clipboard-win32-x64-msvc"
            clipboard_native_file="clipboard.win32-x64-msvc.node"
            ;;
        windows-arm64)
            clipboard_native_package="clipboard-win32-arm64-msvc"
            clipboard_native_file="clipboard.win32-arm64-msvc.node"
            ;;
    esac
    mkdir -p "$OUTPUT_DIR/$platform/node_modules/@mariozechner"
    cp -r ../../node_modules/@mariozechner/clipboard "$OUTPUT_DIR/$platform/node_modules/@mariozechner/"
    cp -r ../../node_modules/@mariozechner/$clipboard_native_package "$OUTPUT_DIR/$platform/node_modules/@mariozechner/"
    cp "../../node_modules/@mariozechner/$clipboard_native_package/$clipboard_native_file" \
        "$OUTPUT_DIR/$platform/node_modules/@mariozechner/clipboard/"

    # Extension dependencies next to the executable: extensions loaded from
    # extensions/phi resolve them by walking up to this node_modules, and the
    # copies made in the agent dir link to it (src/core/bundled-assets.ts).
    if [[ "$SKIP_EXTENSION_DEPS" == "false" ]]; then
        echo "Staging extension dependencies for $platform..."
        ext_staging=$(mktemp -d)
        stage_extension_deps "$platform" "$ext_staging"
        prune_extension_deps "$platform" "$ext_staging"
        rm -rf "$ext_staging/node_modules/.bin"
        cp -R "$ext_staging/node_modules/." "$OUTPUT_DIR/$platform/node_modules/"
        rm -rf "$ext_staging"
    fi

    # Copy terminal input native helpers next to compiled binaries.
    if [[ "$platform" == darwin-* ]]; then
        mkdir -p "$OUTPUT_DIR/$platform/native/darwin/prebuilds/$platform"
        cp ../tui/native/darwin/prebuilds/$platform/darwin-modifiers.node "$OUTPUT_DIR/$platform/native/darwin/prebuilds/$platform/"
    fi
    if [[ "$platform" == windows-* ]]; then
        if [[ "$platform" == "windows-arm64" ]]; then
            win32_arch_dir="win32-arm64"
        else
            win32_arch_dir="win32-x64"
        fi
        mkdir -p "$OUTPUT_DIR/$platform/native/win32/prebuilds/$win32_arch_dir"
        cp ../tui/native/win32/prebuilds/$win32_arch_dir/win32-console-mode.node "$OUTPUT_DIR/$platform/native/win32/prebuilds/$win32_arch_dir/"
    fi
done

if [[ -n "$EXTENSION_TARBALLS_DIR" ]]; then
    rm -rf "$EXTENSION_TARBALLS_DIR"
fi

# Create archives
cd "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        # Windows (zip)
        echo "Creating phi-$platform.zip..."
        (cd "$platform" && zip -r ../phi-$platform.zip .)
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating phi-$platform.tar.gz..."
        mv "$platform" phi && tar -czf phi-$platform.tar.gz phi && mv phi "$platform"
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$platform"
    if [[ "$platform" == windows-* ]]; then
        mkdir -p "$platform" && (cd "$platform" && unzip -q ../phi-$platform.zip)
    else
        tar -xzf phi-$platform.tar.gz && mv phi "$platform"
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in $OUTPUT_DIR/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "  $OUTPUT_DIR/$platform/phi.exe"
    else
        echo "  $OUTPUT_DIR/$platform/phi"
    fi
done
