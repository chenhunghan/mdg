/**
 * Grep execution via just-bash with FTS acceleration.
 *
 * Flow:
 *   1. If index exists, use FTS to find candidate files (coarse filter)
 *   2. Narrow the grep args to only those files
 *   3. Execute grep via just-bash for exact output formatting
 *   4. If --semantic flag, use vector search instead
 */
import { Bash } from "just-bash";
import { MdgFs } from "../fs/mdgfs.ts";
import { findMatchingFiles, searchVector, searchHybrid } from "../search/index.ts";

export interface GrepOptions {
  /** The search pattern */
  pattern: string;
  /** File/directory paths to search (default: current directory) */
  paths: string[];
  /** Raw grep flags (e.g., -i, -n, -r, -l, etc.) */
  flags: string[];
  /** Use vector/semantic search instead of text grep */
  semantic?: boolean;
  /** Use hybrid search (RRF fusion of FTS + vector) */
  hybrid?: boolean;
  /** Working directory */
  cwd: string;
  /** Pattern was supplied via -e/--regexp */
  patternFromFlag?: boolean;
}

export interface GrepResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a grep-like search over markdown files.
 */
export async function executeGrep(options: GrepOptions): Promise<GrepResult> {
  const { pattern, paths, flags, cwd, patternFromFlag = false } = options;

  // Semantic search mode
  if (options.semantic) {
    return executeSemanticSearch(pattern, paths, cwd, flags);
  }

  // Hybrid search mode (RRF fusion of FTS + vector)
  if (options.hybrid) {
    return executeHybridSearch(pattern, paths, cwd, flags);
  }

  // Build the grep command
  const grepArgs = buildGrepArgs(pattern, paths, flags, patternFromFlag);

  // Try FTS acceleration: use the index to find candidate files
  let narrowedArgs = grepArgs;
  if (paths.length === 0) {
    try {
      const candidateFiles = findMatchingFiles(pattern);
      if (candidateFiles.length > 0 && candidateFiles.length < 200) {
        // Narrow grep to only candidate files (FTS coarse filter)
        narrowedArgs = buildNarrowedGrepArgs(
          pattern,
          candidateFiles,
          flags,
          patternFromFlag
        );
      }
    } catch {
      // Index may not exist yet, fall through to full grep
    }
  }

  // Execute via just-bash with our read-only VFS
  const mdgFs = new MdgFs(cwd);
  const bash = new Bash({ fs: mdgFs, cwd: "/" });

  try {
    const result = await bash.exec(`grep ${narrowedArgs}`);
    return {
      stdout: normalizeDefaultOutput(result.stdout, paths.length === 0),
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (e: any) {
    return {
      stdout: "",
      stderr: e.message || "grep failed",
      exitCode: 2,
    };
  }
}

function normalizeDefaultOutput(stdout: string, prefixDotSlash: boolean): string {
  if (!prefixDotSlash || !stdout) return stdout;

  return stdout
    .split("\n")
    .map((line) => {
      if (
        line === "" ||
        line.startsWith("./") ||
        line.startsWith("/") ||
        line === "--" ||
        line.startsWith("Binary file")
      ) {
        return line;
      }
      return `./${line}`;
    })
    .join("\n");
}

/**
 * Build grep arguments string.
 */
function buildGrepArgs(
  pattern: string,
  paths: string[],
  flags: string[],
  patternFromFlag: boolean
): string {
  const parts: string[] = [];
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

  // Always add recursive flag for directory searches
  const hasRecursive = flags.some((f) => f === "-r" || f === "-R" || f === "--recursive");

  // Add user flags, preserving flag/value pairs
  let patternConsumed = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    parts.push(flag);

    if (!flagsWithValue.has(flag)) continue;

    const value = flags[i + 1];
    if (value === undefined) continue;
    parts.push(`'${value.replace(/'/g, "'\\''")}'`);
    i++;

    if (flag === "-e" || flag === "--regexp") {
      patternConsumed = true;
    }
  }

  // Add pattern (properly quoted)
  if (!patternFromFlag || !patternConsumed) {
    parts.push(`'${pattern.replace(/'/g, "'\\''")}'`);
  }

  // Add paths or default to current dir
  if (paths.length > 0) {
    for (const p of paths) {
      parts.push(`'${p.replace(/'/g, "'\\''")}'`);
    }
  } else {
    if (!hasRecursive) {
      parts.push("-r");
    }
    parts.push(".");
  }

  return parts.join(" ");
}

/**
 * Build narrowed grep args targeting only FTS-matched files.
 * Keeps -r flag because just-bash's grep requires it even for file targets.
 */
function buildNarrowedGrepArgs(
  pattern: string,
  candidateFiles: string[],
  flags: string[],
  patternFromFlag: boolean
): string {
  const parts: string[] = [];
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

  // Keep all flags including -r (just-bash grep needs it for file reads)
  let patternConsumed = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    parts.push(flag);

    if (!flagsWithValue.has(flag)) continue;

    const value = flags[i + 1];
    if (value === undefined) continue;
    parts.push(`'${value.replace(/'/g, "'\\''")}'`);
    i++;

    if (flag === "-e" || flag === "--regexp") {
      patternConsumed = true;
    }
  }

  // Ensure -r is present for just-bash compatibility
  const hasRecursive = flags.some(
    (f) => f === "-r" || f === "-R" || f === "--recursive"
  );
  if (!hasRecursive) {
    parts.push("-r");
  }

  // Add pattern unless it came from -e/--regexp
  if (!patternFromFlag || !patternConsumed) {
    parts.push(`'${pattern.replace(/'/g, "'\\''")}'`);
  }

  // Add only the candidate files
  for (const f of candidateFiles) {
    parts.push(`'${f.replace(/'/g, "'\\''")}'`);
  }

  return parts.join(" ");
}

/**
 * Format search results (vector, hybrid) as grep-like output.
 */
export function formatSearchResults(
  results: { filePath: string; content: string; startLine: number; score: number; method: string }[],
  flags: string[],
  options: { explicitPaths?: boolean } = {}
): GrepResult {
  if (results.length === 0) {
    return { stdout: "", stderr: "", exitCode: 1 };
  }

  const explicitPaths = options.explicitPaths ?? false;
  const showLineNumbers = flags.includes("-n") || flags.includes("--line-number");
  const showFilenames =
    flags.includes("-H") ||
    flags.includes("--with-filename") ||
    !explicitPaths ||
    results.length > 1;
  const onlyFilenames = flags.includes("-l") || flags.includes("--files-with-matches");

  if (onlyFilenames) {
    const uniqueFiles = [...new Set(results.map((r) => r.filePath))];
    return {
      stdout: uniqueFiles.join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    };
  }

  const lines: string[] = [];
  for (const result of results) {
    const displayPath = explicitPaths ? result.filePath : `./${result.filePath}`;
    const contentLines = result.content.split("\n");
    for (let i = 0; i < contentLines.length; i++) {
      const line = contentLines[i]!;
      if (line.trim() === "") continue;

      let output = "";
      if (showFilenames) {
        output += `${displayPath}:`;
      }
      if (showLineNumbers) {
        output += `${result.startLine + i}:`;
      }
      output += line;
      lines.push(output);
    }
  }

  return {
    stdout: lines.join("\n") + "\n",
    stderr: "",
    exitCode: 0,
  };
}

/**
 * Semantic/vector search mode — output formatted like grep.
 */
async function executeSemanticSearch(
  query: string,
  paths: string[],
  cwd: string,
  flags: string[]
): Promise<GrepResult> {
  try {
    const results = await searchVector(query, {
      limit: 20,
      filePaths: paths.length > 0 ? paths : undefined,
    });
    return formatSearchResults(results, flags, { explicitPaths: paths.length > 0 });
  } catch (e: any) {
    return {
      stdout: "",
      stderr: `semantic search error: ${e.message}`,
      exitCode: 2,
    };
  }
}

/**
 * Hybrid search mode — RRF fusion of FTS + vector, output formatted like grep.
 */
async function executeHybridSearch(
  query: string,
  paths: string[],
  cwd: string,
  flags: string[]
): Promise<GrepResult> {
  try {
    const results = await searchHybrid(query, {
      limit: 20,
      filePaths: paths.length > 0 ? paths : undefined,
    });
    return formatSearchResults(results, flags, { explicitPaths: paths.length > 0 });
  } catch (e: any) {
    return {
      stdout: "",
      stderr: `hybrid search error: ${e.message}`,
      exitCode: 2,
    };
  }
}
