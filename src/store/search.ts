import type { EmbeddingProvider } from "../embeddings/provider.js";
import type { ChunkStore } from "./chunkStore.js";
import type { ScoredChunk } from "./types.js";
import type { VectorStore } from "./vectorStore.js";

/**
 * Semantic search: embed the query, find nearest chunks, and hydrate them with
 * their Obsidian citation metadata. This is the retrieval primitive reused by
 * the grounding pipeline ("reuse, don't reinvent" search).
 */
export class SearchService {
  constructor(
    private readonly embeddings: EmbeddingProvider,
    private readonly vectorStore: VectorStore,
    private readonly chunkStore: ChunkStore,
  ) {}

  async search(query: string, limit: number): Promise<ScoredChunk[]> {
    const queryVector = await this.embeddings.embedOne(query);
    const hits = this.vectorStore.knn(queryVector, limit);
    if (hits.length === 0) return [];

    const distanceById = new Map(hits.map((hit) => [hit.chunkId, hit.distance] as const));
    const stored = this.chunkStore.hydrate(hits.map((hit) => hit.chunkId));

    return stored.map((chunk) => {
      const distance = distanceById.get(chunk.chunkId) ?? 0;
      return { ...chunk, distance, score: distanceToScore(distance) };
    });
  }
}

/** Maps L2 distance between normalized vectors to a cosine similarity in 0..1. */
function distanceToScore(distance: number): number {
  const cosine = 1 - (distance * distance) / 2;
  return Math.max(0, Math.min(1, cosine));
}
