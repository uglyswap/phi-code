#!/usr/bin/env node
/**
 * Post-install script: copies bundled extensions, agents, and skills
 * to ~/.phi/agent/ so Pi discovers them automatically.
 */
const { existsSync, mkdirSync, cpSync, readdirSync } = require("fs");
const { join } = require("path");
const { homedir } = require("os");

const agentDir = join(homedir(), ".phi", "agent");
const packageDir = __dirname.replace(/[/\\]scripts$/, "");

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
    const srcPath = join(srcDir, file);
    const destPath = join(dest, file);
    try {
      cpSync(srcPath, destPath, { recursive: true, force: true });
      copied++;
    } catch (e) {
      // Skip files that can't be copied (permissions, etc.)
    }
  }
  if (copied > 0) {
    console.log(`  Φ Installed ${copied} ${label} to ${dest}`);
  }
}
