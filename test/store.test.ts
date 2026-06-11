import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { Chunk } from "../src/chunk/types.js";
import { ChunkStore } from "../src/store/chunkStore.js";
import { openDb } from "../src/store/db.js";
import { FALLBACK_VEC_SCHEMA_SQL } from "../src/store/schema.js";
import { VectorStore } from "../src/store/vectorStore.js";

function makeChunk(text: string, ordinal: number, anchor: string, blockId: string | null): Chunk {
  return {
    text,
    ordinal,
    charStart: 0,
    charEnd: text.length,
    tokenEst: Math.ceil(text.length / 4),
    meta: {
      path: "Projects/Auth.md",
      headingPath: "Auth > Decisions",
      blockId,
      anchor,
      wikilinks: [],
    },
  };
}

const vec = (values: number[]): Float32Array => Float32Array.from(values);

describe("store layer", () => {
  it("round-trips chunks through KNN with Obsidian citation metadata", () => {
    const { db } = openDb({ path: ":memory:", embeddingModel: "test", dim: 4 });
    const chunks = new ChunkStore(db);
    const vectors = new VectorStore(db);

    const noteId = chunks.insertNote({ path: "Projects/Auth.md", mtimeMs: 1, contentHash: "h0" }, 1);
    const c1 = chunks.insertChunk(noteId, makeChunk("postgres decision", 0, "#^k93a", "k93a"));
    const c2 = chunks.insertChunk(noteId, makeChunk("auth timeline", 1, "#Timeline", null));
    const c3 = chunks.insertChunk(noteId, makeChunk("unrelated note", 2, "#L3", null));

    vectors.insert(c1, vec([1, 0, 0, 0]));
    vectors.insert(c2, vec([0.8, 0.2, 0, 0]));
    vectors.insert(c3, vec([0, 0, 0, 1]));

    // Query closest to c1, then c2; c3 is far.
    const hits = vectors.knn(vec([1, 0, 0, 0]), 2);
    expect(hits.map((h) => h.chunkId)).toEqual([c1, c2]);
    expect(hits[0]?.distance).toBeCloseTo(0, 5);

    const hydrated = chunks.hydrate(hits.map((h) => h.chunkId));
    expect(hydrated.map((c) => c.chunkId)).toEqual([c1, c2]);
    expect(hydrated[0]?.anchor).toBe("#^k93a");
    expect(hydrated[0]?.blockId).toBe("k93a");
    expect(hydrated[0]?.notePath).toBe("Projects/Auth.md");
    expect(hydrated[0]?.headingPath).toBe("Auth > Decisions");

    db.close();
  });

  it("deletes a note's chunks and vector rows together", () => {
    const { db } = openDb({ path: ":memory:", embeddingModel: "test", dim: 4 });
    const chunks = new ChunkStore(db);
    const vectors = new VectorStore(db);

    const noteId = chunks.insertNote({ path: "Note.md", mtimeMs: 1, contentHash: "h0" }, 1);
    const a = chunks.insertChunk(noteId, makeChunk("a", 0, "#L1", null));
    const b = chunks.insertChunk(noteId, makeChunk("b", 1, "#L2", null));
    vectors.insert(a, vec([1, 0, 0, 0]));
    vectors.insert(b, vec([0, 1, 0, 0]));
    expect(vectors.count()).toBe(2);

    // Correct deletion order: clear vec rows by id, then cascade the note.
    vectors.deleteByChunkIds(chunks.getChunkIdsForNote(noteId));
    chunks.deleteNoteRow(noteId);

    expect(vectors.count()).toBe(0);
    expect(chunks.getChunk(a)).toBeUndefined();
    expect(chunks.getNoteId("Note.md")).toBeUndefined();
    db.close();
  });

  it("rebuilds the index when the embedding model/dim changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "anchor-db-"));
    const dbPath = join(dir, "index.db");

    let opened = openDb({ path: dbPath, embeddingModel: "model-a", dim: 4 });
    const store = new ChunkStore(opened.db);
    const noteId = store.insertNote({ path: "N.md", mtimeMs: 1, contentHash: "h0" }, 1);
    store.insertChunk(noteId, makeChunk("text", 0, "#L0", null));
    expect(store.getNote("N.md")).toBeDefined();
    opened.db.close();

    // Reopen with a different model + dim — the stored index must be cleared.
    opened = openDb({ path: dbPath, embeddingModel: "model-b", dim: 8 });
    expect(new ChunkStore(opened.db).getNote("N.md")).toBeUndefined();
    opened.db.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it("brute-forces KNN in the pure-JS fallback backend", () => {
    const db = new Database(":memory:");
    db.exec(FALLBACK_VEC_SCHEMA_SQL);
    const vectors = new VectorStore(db, "fallback");

    vectors.insert(1, Float32Array.from([1, 0, 0, 0]));
    vectors.insert(2, Float32Array.from([0.8, 0.2, 0, 0]));
    vectors.insert(3, Float32Array.from([0, 0, 0, 1]));

    const hits = vectors.knn(Float32Array.from([1, 0, 0, 0]), 2);
    expect(hits.map((hit) => hit.chunkId)).toEqual([1, 2]);
    expect(hits[0]?.distance).toBeCloseTo(0, 5);
    expect(vectors.count()).toBe(3);
    db.close();
  });
});
