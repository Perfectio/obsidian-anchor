import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { chunkNote } from "../chunk/chunker.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import type { ChunkStore } from "../store/chunkStore.js";
import type { Db } from "../store/db.js";
import type { VectorStore } from "../store/vectorStore.js";
import { sha256 } from "../util/hash.js";
import { logger } from "../util/logger.js";
import { walkVault } from "./walk.js";

export interface IndexStats {
  /** Notes (re)indexed this pass. */
  notes: number;
  /** Chunks written this pass. */
  chunks: number;
  /** Notes skipped as unchanged, empty, or binary. */
  skipped: number;
  /** Notes that failed to index (read/parse/embed error) and were skipped. */
  errored: number;
  /** Notes removed because they no longer exist on disk. */
  pruned: number;
}

/**
 * Builds and maintains the vault index: walk -> chunk -> embed -> store. Uses a
 * per-note content hash to skip unchanged files, so repeated passes are cheap
 * (full incremental file-watching lands in a later milestone).
 */
export class Indexer {
  constructor(
    private readonly vaultPath: string,
    private readonly db: Db,
    private readonly chunkStore: ChunkStore,
    private readonly vectorStore: VectorStore,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async indexAll(): Promise<IndexStats> {
    const files = await walkVault(this.vaultPath);
    const fileSet = new Set(files);
    const stats: IndexStats = { notes: 0, chunks: 0, skipped: 0, errored: 0, pruned: 0 };
    for (const rel of files) {
      try {
        const written = await this.indexFile(rel);
        if (written === null) {
          stats.skipped += 1;
        } else {
          stats.notes += 1;
          stats.chunks += written;
        }
      } catch (error) {
        // A single unreadable / malformed note must never abort the whole pass.
        stats.errored += 1;
        logger.warn("Skipped a note that failed to index", {
          path: rel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Prune notes deleted on disk while the watcher wasn't running, so the index
    // never cites a note that no longer exists.
    for (const note of this.chunkStore.getAllNotes()) {
      if (!fileSet.has(note.path)) {
        this.removeNote(note.path);
        stats.pruned += 1;
      }
    }

    logger.info("Indexing complete", { ...stats, files: files.length });
    return stats;
  }

  /** Indexes one note; returns chunk count, or null if skipped (unchanged/empty/binary). */
  async indexFile(rel: string): Promise<number | null> {
    const abs = join(this.vaultPath, rel);
    const [buffer, fileStat] = await Promise.all([readFile(abs), stat(abs)]);

    // Skip binary-looking files: a zero byte never appears in real markdown, but
    // a mislabelled binary or non-UTF8 file would otherwise embed as garbage.
    if (buffer.includes(0)) {
      logger.debug("Skipping binary-looking file", { path: rel });
      return null;
    }

    const content = buffer.toString("utf8");
    const hash = sha256(content);

    const existing = this.chunkStore.getNote(rel);
    if (existing) {
      if (existing.contentHash === hash) return null; // unchanged
      // Changed: drop the old chunks (cascades wikilinks) and their vector rows.
      this.vectorStore.deleteByChunkIds(this.chunkStore.getChunkIdsForNote(existing.noteId));
      this.chunkStore.deleteNoteRow(existing.noteId);
    }

    const chunks = chunkNote(rel, content);
    if (chunks.length === 0) return null;

    // Embedding is async, so it must happen outside the synchronous transaction.
    const vectors = await this.embeddings.embed(chunks.map((chunk) => chunk.text));

    const persist = this.db.transaction(() => {
      const noteId = this.chunkStore.insertNote(
        { path: rel, mtimeMs: Math.floor(fileStat.mtimeMs), contentHash: hash },
        Date.now(),
      );
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const vector = vectors[i];
        if (chunk === undefined || vector === undefined) continue;
        const chunkId = this.chunkStore.insertChunk(noteId, chunk);
        this.vectorStore.insert(chunkId, vector);
      }
    });
    persist();

    return chunks.length;
  }

  /** Removes a note and its chunks/vectors from the index (for deletions). */
  removeNote(rel: string): void {
    const existing = this.chunkStore.getNote(rel);
    if (!existing) return;
    this.vectorStore.deleteByChunkIds(this.chunkStore.getChunkIdsForNote(existing.noteId));
    this.chunkStore.deleteNoteRow(existing.noteId);
  }
}
