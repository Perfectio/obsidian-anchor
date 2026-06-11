// Embedding backend abstraction. The default is a fully local, no-API-key
// provider; an OpenAI provider is a drop-in accuracy upgrade. The store fixes
// the vec0 column width to `dim`, so changing providers triggers a rebuild.

export interface EmbeddingProvider {
  /** Stable id persisted in the index meta (e.g. "local-minilm"). */
  readonly id: string;
  /** Output dimensionality; must match the vec0 column width. */
  readonly dim: number;
  /** Embeds a batch of texts into normalized vectors (same order as input). */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Embeds a single text. */
  embedOne(text: string): Promise<Float32Array>;
}
