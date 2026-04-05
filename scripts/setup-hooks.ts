#!/usr/bin/env bun

import { existsSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const repoRoot = import.meta.dir ? join(import.meta.dir, "..") : ".";
const sourceHook = join(repoRoot, ".githooks", "commit-msg");
const targetDir = join(repoRoot, ".git", "hooks");
const targetHook = join(targetDir, "commit-msg");

if (!existsSync(sourceHook)) {
  console.log("commit-msg hook template not found; skipping hook setup.");
  process.exit(0);
}

if (!existsSync(targetDir)) {
  mkdirSync(targetDir, { recursive: true });
}

copyFileSync(sourceHook, targetHook);
chmodSync(targetHook, 0o755);

console.log(`Installed commit-msg hook at ${targetHook}`);
