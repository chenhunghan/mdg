/**
 * Indexing pipeline: scan, hash, chunk, embed, store.
 * Supports incremental indexing (only re-indexes changed files).
 */
import { getDb, ensureVecTable } from "../db/index.ts";
import { scanMarkdownFiles, hashFile, readMarkdownFile } from "./scanner.ts";
import { chunkMarkdown } from "./chunker.ts";
import {
  embed,
  embedBatch,
  getEmbeddingDimensions,
  getModelId,
} from "../embedder/index.ts";

export interface IndexStats {
  totalFiles: number;
  newFiles: number;
  updatedFiles: number;
  deletedFiles: number;
  totalChunks: number;
  embeddedChunks: number;
  durationMs: number;
}

interface FileRow {
  id: number;
  path: string;
  abs_path: string;
  file_hash: string;
  chunk_count: number;
  indexed_at: number;
}

/**
 * Check if the chunks_vec virtual table exists.
 */
function vecTableExists(): boolean {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_vec'"
    )
    .get();
  return !!row;
}

/**
 * Safely delete vec entries for a file. No-op if vec table doesn't exist.
 */
function deleteVecEntriesForFile(fileId: number): void {
  if (!vecTableExists()) return;
  const db = getDb();
  try {
    const chunkIds = db
      .prepare("SELECT id FROM chunks WHERE file_id = ?")
      .all(fileId) as { id: number }[];
    const stmt = db.prepare("DELETE FROM chunks_vec WHERE chunk_id = ?");
    for (const c of chunkIds) {
      try {
        stmt.run(c.id);
      } catch {
        // ignore individual failures
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Run the full indexing pipeline for the given root directory.
 * @param root - Directory to scan for .md files
 * @param options - Control what gets indexed
 */
export async function indexDirectory(
  root: string,
  options: {
    /** Force re-index everything (ignore hashes) */
    force?: boolean;
    /** Skip embedding generation (FTS only) */
    skipEmbeddings?: boolean;
    /** Progress callback */
    onProgress?: (msg: string) => void;
  } = {}
): Promise<IndexStats> {
  const start = Date.now();
  const db = getDb();
  const log = options.onProgress || (() => {});

  const stats: IndexStats = {
    totalFiles: 0,
    newFiles: 0,
    updatedFiles: 0,
    deletedFiles: 0,
    totalChunks: 0,
    embeddedChunks: 0,
    durationMs: 0,
  };

  // 1. Scan filesystem
  log("Scanning for markdown files...");
  const scannedFiles = await scanMarkdownFiles(root);
  stats.totalFiles = scannedFiles.length;
  log(`Found ${scannedFiles.length} markdown files`);

  // 2. Get existing file records
  const existingFiles = db.prepare("SELECT * FROM files").all() as FileRow[];
  const existingByPath = new Map(existingFiles.map((f) => [f.path, f]));

  // 3. Determine which files changed
  const scannedPaths = new Set(scannedFiles.map((f) => f.relPath));

  // Delete removed files
  const deletedFiles = existingFiles.filter((f) => !scannedPaths.has(f.path));
  if (deletedFiles.length > 0) {
    const deleteChunks = db.prepare("DELETE FROM chunks WHERE file_id = ?");
    const deleteFile = db.prepare("DELETE FROM files WHERE id = ?");

    const deleteTx = db.transaction(() => {
      for (const f of deletedFiles) {
        deleteVecEntriesForFile(f.id);
        deleteChunks.run(f.id);
        deleteFile.run(f.id);
      }
    });
    deleteTx();
    stats.deletedFiles = deletedFiles.length;
    log(`Removed ${deletedFiles.length} deleted files from index`);
  }

  // 4. Process each scanned file
  const insertFile = db.prepare(
    `INSERT INTO files (path, abs_path, file_hash, chunk_count, indexed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       abs_path = excluded.abs_path,
       file_hash = excluded.file_hash,
       chunk_count = excluded.chunk_count,
       indexed_at = excluded.indexed_at`
  );

  const deleteChunksForFile = db.prepare(
    "DELETE FROM chunks WHERE file_id = ?"
  );

  const insertChunk = db.prepare(
    `INSERT INTO chunks (file_id, chunk_index, content, start_line, end_line)
     VALUES (?, ?, ?, ?, ?)`
  );

  const getFileId = db.prepare("SELECT id FROM files WHERE path = ?");

  let processedCount = 0;

  for (const file of scannedFiles) {
    const existing = existingByPath.get(file.relPath);
    const currentHash = await hashFile(file.absPath);

    // Skip unchanged files unless forced
    if (!options.force && existing && existing.file_hash === currentHash) {
      processedCount++;
      continue;
    }

    const isNew = !existing;
    if (isNew) {
      stats.newFiles++;
    } else {
      stats.updatedFiles++;
    }

    // Read and chunk file
    const content = await readMarkdownFile(file.absPath);
    const chunks = chunkMarkdown(content);

    // Transactionally update file + chunks
    const tx = db.transaction(() => {
      // Upsert file record
      insertFile.run(
        file.relPath,
        file.absPath,
        currentHash,
        chunks.length,
        Date.now()
      );

      const fileRow = getFileId.get(file.relPath) as { id: number };
      const fileId = fileRow.id;

      // Delete old chunks for this file
      if (!isNew) {
        deleteVecEntriesForFile(fileId);
        deleteChunksForFile.run(fileId);
      }

      // Insert new chunks
      for (const chunk of chunks) {
        insertChunk.run(
          fileId,
          chunk.index,
          chunk.content,
          chunk.startLine,
          chunk.endLine
        );
      }

      stats.totalChunks += chunks.length;
    });
    tx();

    processedCount++;
    if (processedCount % 10 === 0 || processedCount === scannedFiles.length) {
      log(`Indexed ${processedCount}/${scannedFiles.length} files`);
    }
  }

  // 5. Generate embeddings (if not skipped)
  if (!options.skipEmbeddings) {
    await generateEmbeddings(log, stats, options.force);
  }

  stats.durationMs = Date.now() - start;
  return stats;
}

/**
 * Generate embeddings for chunks that don't have them yet.
 */
async function generateEmbeddings(
  log: (msg: string) => void,
  stats: IndexStats,
  force?: boolean
): Promise<void> {
  const db = getDb();

  // Ensure vec table exists
  log("Initializing embedding model (first run may download the model)...");
  const dimensions = await getEmbeddingDimensions();
  ensureVecTable(dimensions);

  const modelId = await getModelId();
  log(`Embedding model ready (${dimensions} dimensions)`);

  // Find chunks without embeddings (or with wrong model)
  const whereClause = force
    ? ""
    : "WHERE embedding IS NULL OR embed_model != ?";
  const params = force ? [] : [modelId];

  const chunks = db
    .prepare(
      `SELECT c.id, c.content, f.path
       FROM chunks c JOIN files f ON c.file_id = f.id
       ${whereClause}
       ORDER BY c.id`
    )
    .all(...params) as { id: number; content: string; path: string }[];

  if (chunks.length === 0) {
    log("All chunks already have embeddings");
    return;
  }

  const batchSize = 32;
  const totalBatches = Math.max(1, Math.ceil(chunks.length / batchSize));

  log(`Generating embeddings for ${chunks.length} chunks in ${totalBatches} batches...`);

  const updateChunk = db.prepare(
    "UPDATE chunks SET embedding = ?, embed_model = ? WHERE id = ?"
  );

  const insertVec = db.prepare(
    "INSERT OR REPLACE INTO chunks_vec (chunk_id, embedding) VALUES (?, vec_f32(?))"
  );

  // Process in batches
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map((c) => c.content);
    const titles = batch.map((c) => c.path);
    const batchNumber = Math.floor(i / batchSize) + 1;

    log(`Embedding batch ${batchNumber}/${totalBatches} (${batch.length} chunks)...`);

    const embeddings = await embedBatch(texts, "document", titles);

    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]!;
        const vector = embeddings[j]!;
        const buffer = new Float32Array(vector);

        updateChunk.run(Buffer.from(buffer.buffer), modelId, chunk.id);

        insertVec.run(chunk.id, JSON.stringify(vector));
      }
    });
    tx();

    stats.embeddedChunks += batch.length;
    const progress = Math.min(i + batchSize, chunks.length);
    log(`Embedded ${progress}/${chunks.length} chunks`);
  }
}

/**
 * Check if the index needs updating for the given root.
 * Returns true if there are new/changed/deleted files.
 */
export async function needsReindex(root: string): Promise<boolean> {
  const db = getDb();

  const scannedFiles = await scanMarkdownFiles(root);
  const scannedPaths = new Set(scannedFiles.map((f) => f.relPath));

  // Check for new or changed files
  const existingFiles = db
    .prepare("SELECT path, file_hash FROM files")
    .all() as { path: string; file_hash: string }[];
  const existingByPath = new Map(
    existingFiles.map((f) => [f.path, f.file_hash])
  );

  // Deleted files?
  for (const existing of existingFiles) {
    if (!scannedPaths.has(existing.path)) return true;
  }

  // New or changed files?
  for (const file of scannedFiles) {
    const existingHash = existingByPath.get(file.relPath);
    if (!existingHash) return true;

    const currentHash = await hashFile(file.absPath);
    if (currentHash !== existingHash) return true;
  }

  // Check for un-embedded chunks
  const unembedded = db
    .prepare("SELECT COUNT(*) as count FROM chunks WHERE embedding IS NULL")
    .get() as { count: number };
  if (unembedded.count > 0) return true;

  return false;
}

/**
 * Get index status information.
 */
export function getIndexStatus(): {
  totalFiles: number;
  totalChunks: number;
  embeddedChunks: number;
  unembeddedChunks: number;
  lastIndexedAt: number | null;
  dbSizeBytes: number;
} {
  const db = getDb();

  const files = db.prepare("SELECT COUNT(*) as count FROM files").get() as {
    count: number;
  };
  const chunks = db.prepare("SELECT COUNT(*) as count FROM chunks").get() as {
    count: number;
  };
  const embedded = db
    .prepare(
      "SELECT COUNT(*) as count FROM chunks WHERE embedding IS NOT NULL"
    )
    .get() as { count: number };
  const lastIndexed = db
    .prepare("SELECT MAX(indexed_at) as ts FROM files")
    .get() as { ts: number | null };

  let dbSize = 0;
  try {
    const { join } = require("node:path");
    const { homedir } = require("node:os");
    dbSize = Bun.file(join(homedir(), ".mdg", "mdg.db")).size;
  } catch {
    // ignore
  }

  return {
    totalFiles: files.count,
    totalChunks: chunks.count,
    embeddedChunks: embedded.count,
    unembeddedChunks: chunks.count - embedded.count,
    lastIndexedAt: lastIndexed.ts,
    dbSizeBytes: dbSize,
  };
}
