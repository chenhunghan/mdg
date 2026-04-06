#!/usr/bin/env bun
/**
 * mdg — Markdown Grep
 * A CLI tool for searching markdown files powered by FTS + vector search.
 *
 * Usage:
 *   mdg grep [grep-flags] <pattern> [path...]   # hybrid search (default)
 *   mdg index [--force]                          # build/update index
 *   mdg status                                   # show index status
 */
import { indexDirectory, needsReindex, getIndexStatus, refreshEmbeddingsForRoot } from "../indexer/index.ts";
import { executeGrep } from "../search/grep.ts";
import { getDb, closeDb, enqueueEmbeddingRefresh, claimNextEmbeddingJob, completeEmbeddingJob, failEmbeddingJob } from "../db/index.ts";
import { disposeEmbedder, getConfiguredModelUri } from "../embedder/index.ts";
import { isSidecarInstalled, installSidecar } from "../embedder/sidecar.ts";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case "index":
      await runIndex(args.slice(1));
      break;
    case "status":
      await runStatus();
      break;
    case "grep":
      await runGrep(args.slice(1));
      break;
    case "setup":
      await runSetup();
      break;
    case "embedding-worker":
      await runEmbeddingWorker(args.slice(1));
      break;
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    case "--version":
    case "-V":
      console.log("0.1.0");
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  console.log(`mdg — Markdown Grep

Usage:
  mdg grep [grep-flags] <pattern> [path...]   Search markdown files (hybrid by default)
  mdg index [options]                          Build/update search index
  mdg status                                   Show index status
  mdg setup                                    Install hybrid search deps

Grep flags:
  All standard grep flags are supported (-i, -n, -r, -l, -c, -v, -w, -x, etc.)

Index options:
  -f, --force         Force re-index all files
  --no-embeddings     Skip embedding generation (FTS only)

Environment:
  MDG_EMBED_MODEL     Override embedding model (default: embeddinggemma-300M-Q8_0)
                      Set to Qwen3 URI for multilingual support`);
}

// ─── mdg setup ──────────────────────────────────────────────────────
async function runSetup() {
  if (isSidecarInstalled()) {
    console.log("Hybrid search dependencies are already installed.");
    console.log("  Location: ~/.mdg/node_modules/node-llama-cpp");
    return;
  }

  try {
    await installSidecar((msg) => console.log(msg));
    console.log("\nSetup complete. Hybrid search is now available.");
  } catch (e: any) {
    console.error(`Setup failed: ${e.message}`);
    process.exit(1);
  }
}

// ─── mdg index ──────────────────────────────────────────────────────
async function runIndex(args: string[]) {
  const force = args.includes("-f") || args.includes("--force");
  const noEmbeddings = args.includes("--no-embeddings");
  const cwd = process.cwd();

  console.log(`Indexing markdown files in ${cwd}...`);

  try {
    const stats = await indexDirectory(cwd, {
      force,
      skipEmbeddings: noEmbeddings,
      onProgress: (msg) => console.log(`  ${msg}`),
    });

    console.log("\nIndex complete:");
    console.log(
      `  Files:    ${stats.totalFiles} total, ${stats.newFiles} new, ${stats.updatedFiles} updated, ${stats.deletedFiles} deleted`
    );
    console.log(
      `  Chunks:   ${stats.totalChunks} indexed, ${stats.embeddedChunks} embedded`
    );
    console.log(`  Duration: ${(stats.durationMs / 1000).toFixed(1)}s`);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  } finally {
    await disposeEmbedder();
    closeDb();
  }
}

// ─── mdg status ─────────────────────────────────────────────────────
async function runStatus() {
  try {
    const status = getIndexStatus();
    const needsUpdate = await needsReindex(process.cwd());

    console.log("mdg index status:");
    console.log(`  Files:        ${status.totalFiles}`);
    console.log(`  Chunks:       ${status.totalChunks}`);
    console.log(`  Embedded:     ${status.embeddedChunks}`);
    console.log(`  Unembedded:   ${status.unembeddedChunks}`);
    console.log(
      `  DB size:      ${(status.dbSizeBytes / 1024 / 1024).toFixed(1)} MB`
    );
    if (status.lastIndexedAt) {
      console.log(
        `  Last indexed: ${new Date(status.lastIndexedAt).toLocaleString()}`
      );
    }
    console.log(`  Needs update: ${needsUpdate ? "yes" : "no"}`);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  } finally {
    closeDb();
  }
}

// ─── mdg grep ───────────────────────────────────────────────────────
async function runGrep(rawArgs: string[]) {
  const cwd = process.cwd();
  process.env.MDG_EMBED_RUNTIME = process.env.MDG_EMBED_RUNTIME || "ipc";

  await ensureFreshSidecar();

  // Hybrid search is the default; keep legacy flags as no-ops.
  const hybrid = true;
  const grepArgs = rawArgs;

  // Parse grep args
  const { flags, pattern, paths } = parseGrepArgs(grepArgs);
  const patternFromFlag = flags.includes("-e") || flags.includes("--regexp");

  if (!pattern) {
    console.error("Usage: mdg grep [options] <pattern> [path...]");
    process.exit(2);
  }

  // Trigger background maintenance if needed (non-blocking)
  void triggerBackgroundIndex(cwd).finally(() => triggerEmbeddingRefresh(cwd));

  try {
    const result = await executeGrep({
      pattern,
      paths,
      flags,
      hybrid,
      cwd,
      patternFromFlag,
    });

    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }

    process.exit(result.exitCode);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(2);
  } finally {
    closeDb();
  }
}

function triggerEmbeddingRefresh(rootPath: string): void {
  try {
    const modelId = getConfiguredModelUri();
    enqueueEmbeddingRefresh({ rootPath, modelId });

    const entry = process.argv[1] || "";
    const workerArgs = entry.endsWith(".ts") || entry.endsWith(".js")
      ? [entry, "embedding-worker", rootPath]
      : ["embedding-worker", rootPath];

    const child = spawn(process.execPath, workerArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Background embedding is best-effort only.
  }
}

async function ensureFreshSidecar(): Promise<void> {
  if (isSidecarInstalled()) return;
  await installSidecar((msg) => console.error(msg));
}

async function runEmbeddingWorker(args: string[]) {
  const rootPath = args[0];
  if (!rootPath) {
    process.exit(2);
  }

  process.env.MDG_EMBED_RUNTIME = process.env.MDG_EMBED_RUNTIME || "ipc";

  await ensureFreshSidecar();

  try {
    const modelId = getConfiguredModelUri();
    while (true) {
      const claimed = claimNextEmbeddingJob({ leaseOwner: `${process.pid}`, rootPath, modelId });
      if (!claimed) break;

      try {
        const result = await refreshEmbeddingsForRoot(rootPath);
        if (result.needsRetry) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        completeEmbeddingJob(claimed.job_key, claimed.requested_generation);
      } catch (error: any) {
        failEmbeddingJob(claimed.job_key, error?.message || String(error));
        break;
      }
    }
  } finally {
    closeDb();
    await disposeEmbedder();
  }
}

/**
 * Parse raw args into grep flags, pattern, and paths.
 * Follows GNU grep conventions:
 *   - Args starting with - are flags (until --)
 *   - First non-flag arg is the pattern
 *   - Remaining args are paths
 */
function parseGrepArgs(args: string[]): {
  flags: string[];
  pattern: string;
  paths: string[];
} {
  const flags: string[] = [];
  let pattern = "";
  const paths: string[] = [];
  let seenDoubleDash = false;
  let patternFound = false;

  // Flags that take a value argument
  const flagsWithValue = new Set([
    "-e",
    "--regexp",
    "-f",
    "--file",
    "-m",
    "--max-count",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "--include",
    "--exclude",
    "--exclude-dir",
    "--label",
    "--color",
    "--colour",
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    const attachedContext = arg.match(/^(-[ABC])(\d+)$/);
    if (attachedContext) {
      flags.push(attachedContext[1]!, attachedContext[2]!);
      continue;
    }

    const attachedMax = arg.match(/^(-m)(\d+)$/);
    if (attachedMax) {
      flags.push(attachedMax[1]!, attachedMax[2]!);
      continue;
    }

    if (seenDoubleDash) {
      if (!patternFound) {
        pattern = arg;
        patternFound = true;
      } else {
        paths.push(arg);
      }
      continue;
    }

    if (arg === "--") {
      seenDoubleDash = true;
      continue;
    }

    if (arg.startsWith("-") && !patternFound) {
      flags.push(arg);

      // If this flag takes a value, consume the next arg too
      if (flagsWithValue.has(arg) && i + 1 < args.length) {
        i++;
        flags.push(args[i]!);

        // If -e was used, the value IS the pattern
        if (arg === "-e" || arg === "--regexp") {
          pattern = args[i]!;
          patternFound = true;
        }
      }
      continue;
    }

    if (!patternFound) {
      pattern = arg;
      patternFound = true;
    } else {
      paths.push(arg);
    }
  }

  return { flags, pattern, paths };
}

/**
 * Trigger a background index update (non-blocking).
 * Ensures first `mdg grep` works even without a prior `mdg index`.
 */
function triggerBackgroundIndex(cwd: string): Promise<void> {
  try {
    const db = getDb();
    const fileCount = db
      .prepare("SELECT COUNT(*) as count FROM files")
      .get() as { count: number };

    if (fileCount.count === 0) {
      // No index — do a quick FTS-only index (fire and forget)
      return indexDirectory(cwd, { skipEmbeddings: true }).then(() => undefined).catch(() => undefined);
    } else {
      // Index exists — check for updates in background
      return needsReindex(cwd)
        .then((needs) => {
          if (needs) {
            return indexDirectory(cwd, { skipEmbeddings: true }).then(() => undefined).catch(() => undefined);
          }
          return undefined;
        })
        .catch(() => undefined);
    }
  } catch {
    // DB not ready, skip acceleration
    return Promise.resolve();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
