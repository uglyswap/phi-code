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
  for (const file of files) {
    try {
      cpSync(join(srcDir, file), join(dest, file), { recursive: true, force: true });
      copied++;
    } catch (e) { /* skip */ }
  }
  if (copied > 0) console.log(`  Φ Installed ${copied} ${label} to ${dest}`);
}

// 2. Make sigma packages resolvable from ~/.phi/agent/extensions/
// Create node_modules with symlinks to the actual packages
const sigmaPackages = ["sigma-memory", "sigma-agents", "sigma-skills"];
const extensionsNodeModules = join(agentDir, "extensions", "node_modules");
mkdirSync(extensionsNodeModules, { recursive: true });

for (const pkg of sigmaPackages) {
  const srcPkg = join(packageDir, "node_modules", pkg);
  const destLink = join(extensionsNodeModules, pkg);
  
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

// 3. Create default settings.json with quietStartup if it doesn't exist
const settingsPath = join(agentDir, "settings.json");
if (!existsSync(settingsPath)) {
  try {
    const defaults = { quietStartup: true };
    require("fs").writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), "utf-8");
    console.log(`  Φ Created settings.json (quietStartup: true)`);
  } catch { /* skip */ }
}

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
