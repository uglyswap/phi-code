#!/usr/bin/env node
/**
 * Post-install script: copies bundled extensions, agents, and skills
 * to ~/.phi/agent/ and makes sigma packages resolvable from there.
 */
const { existsSync, mkdirSync, cpSync, readdirSync, symlinkSync, unlinkSync, readlinkSync } = require("fs");
const { join, dirname } = require("path");
const { homedir } = require("os");

const agentDir = join(homedir(), ".phi", "agent");
const packageDir = __dirname.replace(/[\\/]scripts$/, "");

// Opt-out / CI guard: skip the home-directory scaffolding under CI or sandbox
// installs (and when explicitly disabled) to avoid polluting ~/.phi there.
if (process.env.PHI_SKIP_POSTINSTALL || process.env.CI) {
	process.exit(0);
}

// 1. Copy extensions, agents, skills
const copies = [
  { src: "extensions/phi", dest: join(agentDir, "extensions"), label: "extensions" },
  { src: "agents", dest: join(agentDir, "agents"), label: "agents" },
  { src: "skills", dest: join(agentDir, "skills"), label: "skills" },
];

for (const { src, dest, label } of copies) {
  const srcDir = join(packageDir, src);
  if (!existsSync(srcDir)) continue;
  mkdirSync(dest, { recursive: true });
  const files = readdirSync(srcDir);
  let copied = 0;
  const failures = [];
  for (const file of files) {
    try {
      cpSync(join(srcDir, file), join(dest, file), { recursive: true, force: true });
      copied++;
    } catch (e) {
      failures.push({ file, err: e && e.message ? e.message : String(e) });
    }
  }
  if (copied > 0) console.log(`  Φ Installed ${copied} ${label} to ${dest}`);
  // Surface failures without re-throwing (must not fail the npm install).
  if (failures.length > 0) {
    console.warn(`  ⚠ ${failures.length} ${label} failed to install (run with PHI_POSTINSTALL_DEBUG=1 for details)`);
    if (process.env.PHI_POSTINSTALL_DEBUG) {
      for (const f of failures) console.warn(`    - ${f.file}: ${f.err}`);
    }
  }
}

// 2. Make bundled-extension runtime deps resolvable from ~/.phi/agent/extensions/
// Create node_modules with symlinks to the actual packages. Includes the sigma
// packages plus the non-phi-internal deps the bundled extensions import directly
// (zod + the MCP SDK for the mcp extension). typebox and phi-code* resolve via the
// loader's module aliases, so they are not listed here. Any new bundled-extension
// dependency that is not phi-internal and not typebox must be added to this list.
const extensionDeps = ["sigma-memory", "sigma-agents", "sigma-skills", "zod", "@modelcontextprotocol/sdk"];
const extensionsNodeModules = join(agentDir, "extensions", "node_modules");
mkdirSync(extensionsNodeModules, { recursive: true });

for (const pkg of extensionDeps) {
  const srcPkg = join(packageDir, "node_modules", pkg);
  const destLink = join(extensionsNodeModules, pkg);
  mkdirSync(dirname(destLink), { recursive: true });

  if (!existsSync(srcPkg)) {
    // Try parent node_modules (hoisted)
    let parent = dirname(packageDir);
    while (parent !== dirname(parent)) {
      const hoisted = join(parent, "node_modules", pkg);
      if (existsSync(hoisted)) {
        createLink(hoisted, destLink, pkg);
        break;
      }
      parent = dirname(parent);
    }
    continue;
  }
  createLink(srcPkg, destLink, pkg);
}

// 3. Ensure memory directories exist (vector store DB created on first use)
const memoryDir = join(homedir(), ".phi", "memory");
const memoryNotesDir = join(memoryDir, "notes");
const memoryOntologyDir = join(memoryDir, "ontology");
for (const dir of [memoryDir, memoryNotesDir, memoryOntologyDir]) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`  Φ Created ${dir}`);
  }
}

// 4. Ensure settings.json has quietStartup: true
const settingsPath = join(agentDir, "settings.json");
try {
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(require("fs").readFileSync(settingsPath, "utf-8"));
    } catch { settings = {}; }
  }
  if (settings.quietStartup !== true) {
    settings.quietStartup = true;
    require("fs").writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    console.log(`  Φ Set quietStartup: true in settings.json`);
  }
} catch { /* skip */ }

function createLink(src, dest, name) {
  try {
    // Remove existing (symlink or directory)
    if (existsSync(dest)) {
      try { unlinkSync(dest); } catch { 
        try { cpSync(src, dest, { recursive: true, force: true }); return; } catch { return; }
      }
    }
    // Try symlink first, fall back to copy (Windows may not support symlinks)
    try {
      symlinkSync(src, dest, "junction");
      console.log(`  Φ Linked ${name}`);
    } catch {
      cpSync(src, dest, { recursive: true, force: true });
      console.log(`  Φ Copied ${name}`);
    }
  } catch (e) {
    console.log(`  ⚠ Could not install ${name}: ${e.message}`);
  }
}
