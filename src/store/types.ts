// Persistence-facing chunk shapes returned by the store layer.

export interface StoredChunk {
  chunkId: number;
  notePath: string;
  headingPath: string | null;
  blockId: string | null;
  anchor: string;
  ordinal: number;
  charStart: number;
  charEnd: number;
  text: string;
}

export interface ScoredChunk extends StoredChunk {
  /** Raw L2 distance from the query vector (lower = closer). */
  distance: number;
  /** Cosine similarity mapped to 0..1 for display/thresholds (assumes normalized vectors). */
  score: number;
}
