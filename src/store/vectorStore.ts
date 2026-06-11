import type { Db, VectorBackend } from "./db.js";

export interface KnnHit {
  chunkId: number;
  distance: number;
}

/**
 * Owns the embedding store. With the native sqlite-vec extension it uses a vec0
 * virtual table; without it (fallback) it stores blobs in a plain table and
 * brute-forces cosine KNN in JS. Vector rows are keyed by the same chunk id as
 * the relational `chunks` table but are not foreign-key linked, so the indexer
 * must delete vector rows explicitly when a note is re-indexed.
 */
export class VectorStore {
  constructor(
    private readonly db: Db,
    private readonly backend: VectorBackend = "native",
  ) {}

  /** Stores the embedding for a chunk. */
  insert(chunkId: number, embedding: Float32Array): void {
    if (this.backend === "native") {
      // vec0 requires the primary key as a SQLite INTEGER (BigInt) and the vector
      // as a packed float32 blob.
      this.db
        .prepare("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)")
        .run(BigInt(chunkId), toBlob(embedding));
      return;
    }
    this.db
      .prepare("INSERT OR REPLACE INTO vec_chunks_js (chunk_id, embedding) VALUES (?, ?)")
      .run(chunkId, toBlob(embedding));
  }

  /** Approximate-nearest-neighbour search; up to k hits, closest first. */
  knn(query: Float32Array, k: number): KnnHit[] {
    if (this.backend === "native") {
      return this.db
        .prepare(
          "SELECT chunk_id AS chunkId, distance FROM vec_chunks " +
            "WHERE embedding MATCH ? AND k = ? ORDER BY distance",
        )
        .all(toBlob(query), k) as KnnHit[];
    }

    // Fallback: brute-force. Embeddings are unit-normalized, so cosine == dot
    // product, and L2 distance == sqrt(2 - 2*dot).
    const rows = this.db.prepare("SELECT chunk_id AS chunkId, embedding FROM vec_chunks_js").all() as {
      chunkId: number;
      embedding: Buffer;
    }[];
    const scored = rows.map((row) => {
      const vector = bufferToFloat32(row.embedding);
      const length = Math.min(vector.length, query.length);
      let dot = 0;
      for (let i = 0; i < length; i += 1) dot += (query[i] ?? 0) * (vector[i] ?? 0);
      return { chunkId: row.chunkId, distance: Math.sqrt(Math.max(0, 2 - 2 * dot)) };
    });
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, k);
  }

  deleteByChunkIds(chunkIds: number[]): void {
    if (chunkIds.length === 0) return;
    if (this.backend === "native") {
      const stmt = this.db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?");
      for (const id of chunkIds) stmt.run(BigInt(id));
      return;
    }
    const stmt = this.db.prepare("DELETE FROM vec_chunks_js WHERE chunk_id = ?");
    for (const id of chunkIds) stmt.run(id);
  }

  count(): number {
    const table = this.backend === "native" ? "vec_chunks" : "vec_chunks_js";
    const row = this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }
}

/** Packs a Float32Array into a Buffer view for binding as a blob. */
function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function bufferToFloat32(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
}
