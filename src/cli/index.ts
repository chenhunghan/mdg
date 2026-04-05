#!/usr/bin/env bun
/**
 * mdg — Markdown Grep
 * A CLI tool for searching markdown files powered by FTS + vector search.
 *
 * Usage:
 *   mdg grep [grep-flags] <pattern> [path...]   # grep with FTS acceleration
 *   mdg grep --semantic <query> [path...]        # semantic/vector search
 *   mdg index [--force]                          # build/update index
 *   mdg status                                   # show index status
 */
import { indexDirectory, needsReindex, getIndexStatus } from "../indexer/index.ts";
import { executeGrep } from "../search/grep.ts";
import { getDb, closeDb } from "../db/index.ts";
import { disposeEmbedder } from "../embedder/index.ts";
import { isSidecarInstalled, installSidecar } from "../embedder/sidecar.ts";

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
  mdg grep [grep-flags] <pattern> [path...]   Search markdown files
  mdg grep --semantic <query> [path...]        Semantic/vector search
  mdg grep --hybrid <query> [path...]          Hybrid FTS + vector search (RRF)
  mdg index [options]                          Build/update search index
  mdg status                                   Show index status
  mdg setup                                    Install semantic search deps

Grep flags:
  All standard grep flags are supported (-i, -n, -r, -l, -c, -v, -w, -x, etc.)
  --semantic, -s   Use vector/semantic search instead of text grep
  --hybrid         Use hybrid search (RRF fusion of FTS + vector)

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
    console.log("Semantic search dependencies are already installed.");
    console.log("  Location: ~/.mdg/node_modules/node-llama-cpp");
    return;
  }

  try {
    await installSidecar((msg) => console.log(msg));
    console.log("\nSetup complete. You can now use --semantic and --hybrid flags.");
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

  // Extract --semantic / -s and --hybrid flags (our custom flags)
  let semantic = false;
  let hybrid = false;
  const grepArgs = rawArgs.filter((arg) => {
    if (arg === "--semantic" || arg === "-s") {
      semantic = true;
      return false;
    }
    if (arg === "--hybrid") {
      hybrid = true;
      return false;
    }
    return true;
  });

  // Parse grep args
  const { flags, pattern, paths } = parseGrepArgs(grepArgs);
  const patternFromFlag = flags.includes("-e") || flags.includes("--regexp");

  if (!pattern) {
    console.error("Usage: mdg grep [options] <pattern> [path...]");
    process.exit(2);
  }

  // Trigger background index if needed (non-blocking)
  triggerBackgroundIndex(cwd);

  try {
    const result = await executeGrep({
      pattern,
      paths,
      flags,
      semantic,
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
function triggerBackgroundIndex(cwd: string): void {
  try {
    const db = getDb();
    const fileCount = db
      .prepare("SELECT COUNT(*) as count FROM files")
      .get() as { count: number };

    if (fileCount.count === 0) {
      // No index — do a quick FTS-only index (fire and forget)
      indexDirectory(cwd, { skipEmbeddings: true }).catch(() => {});
    } else {
      // Index exists — check for updates in background
      needsReindex(cwd)
        .then((needs) => {
          if (needs) {
            indexDirectory(cwd, { skipEmbeddings: true }).catch(() => {});
          }
        })
        .catch(() => {});
    }
  } catch {
    // DB not ready, skip acceleration
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
