import type { Chunk } from "../chunk/types.js";

import type { Db } from "./db.js";
import type { StoredChunk } from "./types.js";

export interface NoteRecord {
  path: string;
  mtimeMs: number;
  contentHash: string;
}

// Column aliasing so rows hydrate directly into StoredChunk (camelCase) fields.
const HYDRATE_COLUMNS =
  "chunk_id AS chunkId, path AS notePath, heading_path AS headingPath, " +
  "block_id AS blockId, anchor, ordinal, char_start AS charStart, char_end AS charEnd, text";

/**
 * Owns the relational side of the index: notes, chunks, and their wikilinks.
 * Vector rows live in {@link VectorStore} and are keyed by the same chunk id.
 */
export class ChunkStore {
  constructor(private readonly db: Db) {}

  /** Inserts a note row and returns its id. Caller ensures the path is new. */
  insertNote(note: NoteRecord, indexedAt: number): number {
    const result = this.db
      .prepare("INSERT INTO notes (path, mtime_ms, content_hash, indexed_at) VALUES (?, ?, ?, ?)")
      .run(note.path, note.mtimeMs, note.contentHash, indexedAt);
    return Number(result.lastInsertRowid);
  }

  /** Inserts one chunk (and its wikilinks); returns the new chunk id. */
  insertChunk(noteId: number, chunk: Chunk): number {
    const result = this.db
      .prepare(
        "INSERT INTO chunks " +
          "(note_id, path, heading_path, block_id, anchor, ordinal, char_start, char_end, text, token_est) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        noteId,
        chunk.meta.path,
        chunk.meta.headingPath,
        chunk.meta.blockId,
        chunk.meta.anchor,
        chunk.ordinal,
        chunk.charStart,
        chunk.charEnd,
        chunk.text,
        chunk.tokenEst,
      );
    const chunkId = Number(result.lastInsertRowid);
    this.insertWikilinks(chunkId, chunk);
    return chunkId;
  }

  private insertWikilinks(chunkId: number, chunk: Chunk): void {
    if (chunk.meta.wikilinks.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT INTO wikilinks (chunk_id, target_note, target_anchor, alias) VALUES (?, ?, ?, ?)",
    );
    for (const link of chunk.meta.wikilinks) {
      stmt.run(chunkId, link.targetNote, link.targetAnchor, link.alias);
    }
  }

  /** Looks up a note id by path, or undefined if not indexed. */
  getNoteId(path: string): number | undefined {
    const row = this.db.prepare("SELECT note_id AS id FROM notes WHERE path = ?").get(path) as
      | { id: number }
      | undefined;
    return row?.id;
  }

  /** Returns every indexed note (id + path), e.g. to prune ones deleted on disk. */
  getAllNotes(): { noteId: number; path: string }[] {
    return this.db.prepare("SELECT note_id AS noteId, path FROM notes").all() as {
      noteId: number;
      path: string;
    }[];
  }

  /** Looks up a note's id and content hash by path (for incremental indexing). */
  getNote(path: string): { noteId: number; contentHash: string } | undefined {
    return this.db
      .prepare("SELECT note_id AS noteId, content_hash AS contentHash FROM notes WHERE path = ?")
      .get(path) as { noteId: number; contentHash: string } | undefined;
  }

  /** Returns the chunk ids belonging to a note. */
  getChunkIdsForNote(noteId: number): number[] {
    const rows = this.db
      .prepare("SELECT chunk_id AS id FROM chunks WHERE note_id = ?")
      .all(noteId) as { id: number }[];
    return rows.map((r) => r.id);
  }

  getChunk(chunkId: number): StoredChunk | undefined {
    return this.db.prepare(`SELECT ${HYDRATE_COLUMNS} FROM chunks WHERE chunk_id = ?`).get(chunkId) as
      | StoredChunk
      | undefined;
  }

  /** Hydrates chunks by id, preserving the given id order and dropping misses. */
  hydrate(chunkIds: number[]): StoredChunk[] {
    if (chunkIds.length === 0) return [];
    const placeholders = chunkIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT ${HYDRATE_COLUMNS} FROM chunks WHERE chunk_id IN (${placeholders})`)
      .all(...chunkIds) as StoredChunk[];
    const byId = new Map(rows.map((r) => [r.chunkId, r] as const));
    return chunkIds
      .map((id) => byId.get(id))
      .filter((c): c is StoredChunk => c !== undefined);
  }

  /** Deletes a note row by id (cascades chunks + wikilinks via foreign keys). */
  deleteNoteRow(noteId: number): void {
    this.db.prepare("DELETE FROM notes WHERE note_id = ?").run(noteId);
  }
}
