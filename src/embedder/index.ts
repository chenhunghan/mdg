/**
 * Embedding generation via node-llama-cpp with GGUF models.
 * Default model: embeddinggemma-300M-Q8_0
 * Optional: Qwen3-Embedding-0.6B-Q8_0
 *
 * Two modes of operation:
 *   1. In-process: Direct import of node-llama-cpp (dev mode / bun run)
 *   2. IPC subprocess: Spawns ~/.mdg/embed-server.js via bun (compiled binary)
 *
 * The IPC approach is necessary because bun's compiled binary can't resolve
 * transitive dependencies for dynamically imported external packages.
 */
import { join } from "node:path";
import { getMdgDir } from "../db/index.ts";
import {
  isSidecarInstalled,
  installSidecar,
  getEmbedServerPath,
  findBunPath,
} from "./sidecar.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

const DEFAULT_EMBED_MODEL =
  "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

function getModelUri(): string {
  return process.env.MDG_EMBED_MODEL || DEFAULT_EMBED_MODEL;
}

function isQwen3Model(uri: string): boolean {
  return /qwen.*embed/i.test(uri) || /embed.*qwen/i.test(uri);
}

// ─── In-process state (dev mode) ────────────────────────────────────
let _llama: any = null;
let _model: any = null;
let _context: any = null;
let _dimensions: number | null = null;
let _modelUri: string = "";

// ─── IPC subprocess state (compiled binary mode) ────────────────────
let _serverProcess: ChildProcess | null = null;
let _serverRL: Interface | null = null;
let _pendingRequests: Map<
  number,
  { resolve: (v: any) => void; reject: (e: Error) => void }
> = new Map();
let _nextRequestId = 1;
let _useIPC = false;

// ─── Common state ───────────────────────────────────────────────────
let _initPromise: Promise<void> | null = null;

/**
 * Send a JSON-RPC request to the embed server subprocess.
 */
function ipcRequest(method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!_serverProcess || !_serverProcess.stdin) {
      reject(new Error("Embed server not running"));
      return;
    }

    const id = _nextRequestId++;
    _pendingRequests.set(id, { resolve, reject });

    const msg = JSON.stringify({ id, method, params }) + "\n";
    _serverProcess.stdin.write(msg);
  });
}

/**
 * Start the embed server subprocess and wait for it to be ready.
 */
async function startEmbedServer(): Promise<void> {
  const serverPath = getEmbedServerPath();
  const bunPath = findBunPath();

  return new Promise((resolve, reject) => {
    const proc = spawn(bunPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: getMdgDir(),
    });

    _serverProcess = proc;

    // Collect stderr for error reporting
    let stderrBuf = "";
    proc.stderr?.on("data", (data: Buffer) => {
      stderrBuf += data.toString();
      // Forward model download progress to user
      const lines = stderrBuf.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!.trim();
        if (line) console.error(line);
      }
      stderrBuf = lines[lines.length - 1] || "";
    });

    const rl = createInterface({ input: proc.stdout! });
    _serverRL = rl;

    let ready = false;

    rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);

        // Handle readiness signal
        if (msg.ready && !ready) {
          ready = true;
          resolve();
          return;
        }

        // Handle responses
        if (msg.id != null) {
          const pending = _pendingRequests.get(msg.id);
          if (pending) {
            _pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg.result);
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    });

    proc.on("error", (err) => {
      if (!ready) reject(err);
    });

    proc.on("exit", (code) => {
      // Reject any pending requests
      for (const [, pending] of _pendingRequests) {
        pending.reject(new Error(`Embed server exited with code ${code}`));
      }
      _pendingRequests.clear();
      _serverProcess = null;
      _serverRL = null;

      if (!ready) {
        reject(
          new Error(
            `Embed server exited with code ${code} before becoming ready.\n` +
              `stderr: ${stderrBuf}`
          )
        );
      }
    });

    // Timeout after 30 seconds (model download may take longer, but
    // the server signals "ready" before loading the model)
    setTimeout(() => {
      if (!ready) {
        proc.kill();
        reject(new Error("Embed server startup timed out after 30s"));
      }
    }, 30_000);
  });
}

/**
 * Initialize the embedder via IPC (compiled binary mode).
 */
async function initIPC(): Promise<void> {
  // Ensure sidecar is installed
  if (!isSidecarInstalled()) {
    await installSidecar((msg) => console.error(msg));
  }

  // Start the embed server
  await startEmbedServer();

  // Send init command
  const result = await ipcRequest("init", {
    modelUri: getModelUri(),
    modelsDir: join(getMdgDir(), "models"),
  });

  _dimensions = result.dimensions;
  _modelUri = result.modelUri;
}

/**
 * Initialize the embedder in-process (dev mode).
 */
async function initInProcess(llamaCpp: any): Promise<void> {
  const { getLlama, LlamaLogLevel, resolveModelFile } = llamaCpp;

  const modelUri = getModelUri();
  _modelUri = modelUri;

  const modelsDir = join(getMdgDir(), "models");

  _llama = await getLlama({
    logLevel: LlamaLogLevel.error,
  });

  const modelPath = await resolveModelFile(modelUri, modelsDir);

  _model = await _llama.loadModel({ modelPath });
  _context = await _model.createEmbeddingContext();

  // Determine dimensions by doing a test embedding
  const testEmbed = await _context.getEmbeddingFor("test");
  _dimensions = testEmbed.vector.length;
}

/**
 * Ensure the embedder is initialized (either in-process or via IPC).
 */
async function ensureInit(): Promise<void> {
  if (_context || _serverProcess) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    // Strategy 1: try direct import (dev mode)
    try {
      const llamaCpp = await import("node-llama-cpp");
      _useIPC = false;
      await initInProcess(llamaCpp);
      return;
    } catch (error) {
      // Fall back to IPC if the native path collides with Bun's SQLite.
      // This is common after bun:sqlite has already been loaded.
      if (!shouldFallbackToIPC(error)) {
        throw error;
      }
    }

    // Strategy 2: use IPC subprocess
    _useIPC = true;
    await initIPC();
  })();

  return _initPromise;
}

export function shouldFallbackToIPC(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLite already loaded/i.test(message);
}

/**
 * Format text for embedding based on model type.
 */
function formatForEmbedding(
  text: string,
  type: "document" | "query",
  title?: string
): string {
  if (isQwen3Model(_modelUri)) {
    if (type === "query") {
      return `Instruct: Retrieve relevant documents for the given query\nQuery: ${text}`;
    }
    return title ? `${title}\n${text}` : text;
  }

  // embeddinggemma format
  if (type === "query") {
    return `task: search result | query: ${text}`;
  }
  return title ? `title: ${title} | text: ${text}` : `text: ${text}`;
}

/**
 * Get the embedding dimensions (must call after init).
 */
export async function getEmbeddingDimensions(): Promise<number> {
  await ensureInit();
  return _dimensions!;
}

/**
 * Get the model URI string for tracking which model generated embeddings.
 */
export async function getModelId(): Promise<string> {
  await ensureInit();
  return _modelUri;
}

/**
 * Embed a single text string. Returns float32 vector.
 */
export async function embed(
  text: string,
  type: "document" | "query" = "document",
  title?: string
): Promise<number[]> {
  await ensureInit();

  if (_useIPC) {
    const results = await ipcRequest("embed", {
      texts: [text],
      type,
      titles: title ? [title] : undefined,
    });
    return results[0];
  }

  // In-process
  const formatted = formatForEmbedding(text, type, title);
  const result = await _context!.getEmbeddingFor(formatted);
  return Array.from(result.vector);
}

/**
 * Embed a batch of texts. Returns array of float32 vectors.
 */
export async function embedBatch(
  texts: string[],
  type: "document" | "query" = "document",
  titles?: string[]
): Promise<number[][]> {
  await ensureInit();

  if (_useIPC) {
    return ipcRequest("embed", { texts, type, titles });
  }

  // In-process — process in batches of 32 to avoid OOM
  const results: number[][] = [];
  const batchSize = 32;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchTitles = titles?.slice(i, i + batchSize);

    const promises = batch.map(async (text, j) => {
      const title = batchTitles?.[j];
      const formatted = formatForEmbedding(text, type, title);
      const result = await _context!.getEmbeddingFor(formatted);
      return Array.from(result.vector);
    });

    const batchResults = await Promise.all(promises);
    results.push(...(batchResults as number[][]));
  }

  return results;
}

/**
 * Dispose of the embedder (both in-process and IPC).
 */
export async function disposeEmbedder(): Promise<void> {
  if (_useIPC && _serverProcess) {
    try {
      await ipcRequest("dispose");
    } catch {
      // Server might already be dead
    }
    _serverProcess?.kill();
    _serverProcess = null;
    _serverRL?.close();
    _serverRL = null;
    _pendingRequests.clear();
  }

  if (_context) {
    await _context.dispose();
    _context = null;
  }
  if (_model) {
    await _model.dispose();
    _model = null;
  }
  if (_llama) {
    await _llama.dispose();
    _llama = null;
  }
  _initPromise = null;
  _dimensions = null;
}
