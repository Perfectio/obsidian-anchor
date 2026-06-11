import { env, pipeline } from "@huggingface/transformers";

import { logger } from "../util/logger.js";
import type { EmbeddingProvider } from "./provider.js";

// Defaults are English. For non-English vaults, point these at a multilingual
// ONNX model, e.g. ANCHOR_EMBEDDING_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2
// (also 384-dim). Set ANCHOR_EMBEDDING_DIM if the model's dimensionality differs.
const MODEL_ID = process.env.ANCHOR_EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const DIM = Number(process.env.ANCHOR_EMBEDDING_DIM ?? 384);
const BATCH_SIZE = 32;

// The feature-extraction pipeline is callable as (input, opts) => Tensor, where
// input may be a batch of texts. transformers.js ships very broad generic types
// for `pipeline`, so we narrow to the concrete runtime shape we use.
type FeatureExtractor = (
  input: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

/**
 * Local, in-process embeddings via transformers.js — no API key, notes never
 * leave the machine. The model (~80MB) is downloaded once on first use and
 * cached on disk.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  // Model id is part of the identity so switching models triggers a re-index.
  readonly id = `local:${MODEL_ID}`;
  readonly dim = DIM;
  private extractor: Promise<FeatureExtractor> | null = null;

  constructor(cacheDir?: string) {
    if (cacheDir) {
      env.cacheDir = cacheDir;
    }
  }

  private load(): Promise<FeatureExtractor> {
    if (this.extractor === null) {
      logger.info("Loading local embedding model (first run downloads ~80MB)", { model: MODEL_ID });
      this.extractor = (async (): Promise<FeatureExtractor> => {
        try {
          return (await pipeline("feature-extraction", MODEL_ID)) as unknown as FeatureExtractor;
        } catch (error) {
          this.extractor = null; // allow a retry on the next call
          throw new Error(
            `Failed to load the local embedding model '${MODEL_ID}'. It downloads on first use — check network access and disk space.`,
            { cause: error },
          );
        }
      })();
    }
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extract = await this.load();
    const vectors: Float32Array[] = [];
    // Batch to bound memory while still amortizing model overhead across texts.
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const tensor = await extract(batch, { pooling: "mean", normalize: true });
      for (let row = 0; row < batch.length; row++) {
        vectors.push(Float32Array.from(tensor.data.subarray(row * this.dim, (row + 1) * this.dim)));
      }
    }
    return vectors;
  }

  async embedOne(text: string): Promise<Float32Array> {
    const [vector] = await this.embed([text]);
    if (vector === undefined) throw new Error("Embedding produced no vector");
    return vector;
  }
}
