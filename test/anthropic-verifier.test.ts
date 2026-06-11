import { describe, expect, it } from "vitest";

import { AnthropicVerifier, type AnthropicLike } from "../src/verify/anthropic.js";
import type { VerifierInput } from "../src/verify/verifier.js";

function clientReturning(judgements: unknown): AnthropicLike {
  return {
    messages: {
      create: () =>
        Promise.resolve({ content: [{ type: "text", text: JSON.stringify({ judgements }) }] }),
    },
  };
}

const INPUT: VerifierInput = {
  claim: "We use Postgres.",
  passages: [
    { index: 0, path: "a.md", anchor: "#x", text: "We chose Postgres." },
    { index: 1, path: "b.md", anchor: "#y", text: "Auth slipped to Q3." },
  ],
};

describe("AnthropicVerifier", () => {
  it("maps model judgements to passage judgements", async () => {
    const verifier = new AnthropicVerifier(
      clientReturning([
        { passageIndex: 0, label: "supported", confidence: 0.95 },
        { passageIndex: 1, label: "neutral", confidence: 0.8 },
      ]),
    );
    expect(await verifier.entail(INPUT)).toEqual([
      { passageIndex: 0, label: "supported", confidence: 0.95 },
      { passageIndex: 1, label: "neutral", confidence: 0.8 },
    ]);
  });

  it("clamps confidence and defaults missing/invalid passages to neutral", async () => {
    const verifier = new AnthropicVerifier(
      clientReturning([{ passageIndex: 0, label: "contradicted", confidence: 1.5 }]),
    );
    const result = await verifier.entail(INPUT);
    expect(result[0]).toEqual({ passageIndex: 0, label: "contradicted", confidence: 1 });
    expect(result[1]).toEqual({ passageIndex: 1, label: "neutral", confidence: 0 });
  });

  it("falls back to neutral when the API call fails", async () => {
    const failing: AnthropicLike = {
      messages: {
        create: () => {
          throw new Error("boom");
        },
      },
    };
    const verifier = new AnthropicVerifier(failing);
    expect((await verifier.entail(INPUT)).map((judgement) => judgement.label)).toEqual([
      "neutral",
      "neutral",
    ]);
  });

  it("returns nothing when there are no passages", async () => {
    const verifier = new AnthropicVerifier(clientReturning([]));
    expect(await verifier.entail({ claim: "x", passages: [] })).toEqual([]);
  });

  it("sends a request the API accepts (json_schema format, no extra `name`, correct model)", async () => {
    const calls: Record<string, unknown>[] = [];
    const client: AnthropicLike = {
      messages: {
        create: (params) => {
          calls.push(params);
          return Promise.resolve({
            content: [{ type: "text", text: JSON.stringify({ judgements: [] }) }],
          });
        },
      },
    };
    await new AnthropicVerifier(client).entail(INPUT);

    const params = calls[0];
    expect(params?.model).toBe("claude-haiku-4-5");
    const format = (params?.output_config as { format?: Record<string, unknown> } | undefined)
      ?.format;
    expect(format?.type).toBe("json_schema");
    // Regression: the API rejects a `name` field inside output_config.format.
    expect(format).not.toHaveProperty("name");
    expect(format).toHaveProperty("schema");
  });
});
