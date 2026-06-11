import type { EmbeddingProvider } from "./provider.js";

const MODEL = "text-embedding-3-small";
const DIM = 1536;
const ENDPOINT = "https://api.openai.com/v1/embeddings";
const BATCH_SIZE = 128;

// Minimal fetch shape we depend on (Node's global fetch satisfies it; tests inject a fake).
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

/**
 * Optional OpenAI embeddings (opt-in via `--embedding openai` / `ANCHOR_EMBEDDING=openai`).
 * Uses fetch directly — no SDK dependency. Vectors are normalized so cosine/L2
 * ranking matches the local provider.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai-3-small";
  readonly dim = DIM;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(apiKey?: string, fetchImpl?: FetchLike) {
    const key = apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error("OPENAI_API_KEY is required for the OpenAI embedding provider.");
    }
    this.apiKey = key;
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      vectors.push(...(await this.embedBatch(texts.slice(i, i + BATCH_SIZE))));
    }
    return vectors;
  }

  async embedOne(text: string): Promise<Float32Array> {
    const [vector] = await this.embedBatch([text]);
    if (vector === undefined) throw new Error("OpenAI embedding produced no vector");
    return vector;
  }

  private async embedBatch(input: string[]): Promise<Float32Array[]> {
    const response = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: MODEL, input }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `OpenAI embeddings request failed (${String(response.status)}): ${detail.slice(0, 200)}`,
      );
    }
    const parsed = (await response.json()) as { data?: { index?: number; embedding?: number[] }[] };
    const data = [...(parsed.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return data.map((item) => normalize(Float32Array.from(item.embedding ?? [])));
  }
}

/** Normalizes a vector to unit length so dot product == cosine similarity. */
function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}
