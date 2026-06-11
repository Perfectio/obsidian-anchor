import { describe, expect, it } from "vitest";

import { type FetchLike, OpenAIEmbeddingProvider } from "../src/embeddings/openai.js";

function fakeFetch(embeddings: number[][]): FetchLike {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ data: embeddings.map((embedding, index) => ({ index, embedding })) }),
      text: () => Promise.resolve(""),
    });
}

describe("OpenAIEmbeddingProvider", () => {
  it("maps responses to unit-normalized vectors", async () => {
    const provider = new OpenAIEmbeddingProvider("test-key", fakeFetch([[3, 0, 0, 0]]));
    const vector = await provider.embedOne("x");
    expect(vector[0]).toBeCloseTo(1, 5);
  });

  it("preserves order by response index", async () => {
    const provider = new OpenAIEmbeddingProvider("test-key", fakeFetch([
      [1, 0],
      [0, 1],
    ]));
    const vectors = await provider.embed(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]?.[0]).toBeCloseTo(1, 5);
    expect(vectors[1]?.[1]).toBeCloseTo(1, 5);
  });

  it("requires an API key", () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(() => new OpenAIEmbeddingProvider()).toThrow(/OPENAI_API_KEY/);
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
  });
});
