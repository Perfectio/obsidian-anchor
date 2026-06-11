import { describe, expect, it } from "vitest";

import type { SearchService } from "../src/store/search.js";
import type { ScoredChunk } from "../src/store/types.js";
import { decompose } from "../src/verify/decompose.js";
import { GroundingPipeline } from "../src/verify/pipeline.js";
import { aggregate } from "../src/verify/score.js";
import type { PassageJudgement, Verifier, VerifierInput } from "../src/verify/verifier.js";

describe("decompose", () => {
  it("splits sentences and drops questions", () => {
    const claims = decompose("We chose Postgres. The cache is Redis. Why though? ");
    expect(claims.map((c) => c.text)).toEqual(["We chose Postgres.", "The cache is Redis."]);
  });

  it("falls back to the whole text when no sentence survives", () => {
    expect(decompose("Postgres").map((c) => c.text)).toEqual(["Postgres"]);
  });

  it("splits a coordinated sentence, distributing the subject+verb to fragments", () => {
    expect(decompose("We use Redis for caching and Stripe for payments.").map((c) => c.text)).toEqual(
      ["We use Redis for caching", "We use Stripe for payments."],
    );
  });

  it("keeps independent clauses joined by 'and' as separate claims", () => {
    expect(
      decompose("The auth rewrite is in Q3 and the billing rewrite is in Q4.").map((c) => c.text),
    ).toEqual(["The auth rewrite is in Q3", "the billing rewrite is in Q4."]);
  });

  it("does not split a coordination with no verb to distribute", () => {
    expect(decompose("Tabs and spaces.").map((c) => c.text)).toEqual(["Tabs and spaces."]);
  });
});

describe("aggregate", () => {
  it("refuses when any claim is contradicted, even alongside supported ones", () => {
    const result = aggregate([
      { claim: "a", verdict: "supported", score: 0.9, evidence: [] },
      { claim: "b", verdict: "contradicted", score: 0, evidence: [] },
    ]);
    expect(result.verdict).toBe("refused");
    expect(result.grounded).toBe(false);
    expect(result.refusedClaims).toContain("b");
  });

  it("marks an all-supported, high-confidence answer as grounded", () => {
    const result = aggregate([{ claim: "a", verdict: "supported", score: 0.9, evidence: [] }]);
    expect(result.verdict).toBe("grounded");
    expect(result.grounded).toBe(true);
  });

  it("refuses an unsupported (neutral) claim", () => {
    const result = aggregate([{ claim: "a", verdict: "neutral", score: 0, evidence: [] }]);
    expect(result.verdict).toBe("refused");
    expect(result.refusedClaims).toEqual(["a"]);
  });
});

// Deterministic stub: supports postgres claims, contradicts "shipped in March"
// against a "slipped" passage, neutral otherwise.
class StubVerifier implements Verifier {
  readonly id = "stub";
  entail(input: VerifierInput): Promise<PassageJudgement[]> {
    const claim = input.claim.toLowerCase();
    return Promise.resolve(
      input.passages.map((passage) => {
        const text = passage.text.toLowerCase();
        if (claim.includes("shipped in march") && text.includes("slipped")) {
          return { passageIndex: passage.index, label: "contradicted" as const, confidence: 0.95 };
        }
        if (claim.includes("postgres") && text.includes("postgres")) {
          return { passageIndex: passage.index, label: "supported" as const, confidence: 0.9 };
        }
        return { passageIndex: passage.index, label: "neutral" as const, confidence: 0.8 };
      }),
    );
  }
}

function fakeSearch(chunks: ScoredChunk[]): SearchService {
  return { search: () => Promise.resolve(chunks) } as unknown as SearchService;
}

function chunk(text: string, anchor: string): ScoredChunk {
  return {
    chunkId: 1,
    notePath: "Projects/Auth.md",
    headingPath: "Auth Rewrite > Decisions",
    blockId: anchor.startsWith("#^") ? anchor.slice(2) : null,
    anchor,
    ordinal: 0,
    charStart: 0,
    charEnd: text.length,
    text,
    distance: 0,
    score: 1,
  };
}

describe("GroundingPipeline", () => {
  it("grounds a supported claim and cites Obsidian evidence", async () => {
    const pipeline = new GroundingPipeline(
      fakeSearch([chunk("We use Postgres as the primary store.", "#^d4e1")]),
      new StubVerifier(),
      { knn: 5 },
    );
    const result = await pipeline.verify("We chose Postgres for storage.");
    expect(result.verdict).toBe("grounded");
    expect(result.perClaim[0]?.verdict).toBe("supported");
    expect(result.perClaim[0]?.evidence[0]?.anchor).toBe("#^d4e1");
  });

  it("refuses a claim the notes contradict", async () => {
    const pipeline = new GroundingPipeline(
      fakeSearch([chunk("The auth rewrite slipped to Q3; no code shipped in March.", "#^k93a")]),
      new StubVerifier(),
      { knn: 5 },
    );
    const result = await pipeline.verify("The auth rewrite shipped in March.");
    expect(result.verdict).toBe("refused");
    expect(result.perClaim[0]?.verdict).toBe("contradicted");
    expect(result.refusedClaims).toContain("The auth rewrite shipped in March.");
  });

  it("verifies against provided sources, bypassing retrieval", async () => {
    const pipeline = new GroundingPipeline(fakeSearch([]), new StubVerifier(), { knn: 5 });
    const result = await pipeline.verify("We chose Postgres for storage.", [
      chunk("We use Postgres as the primary store.", "#^d4e1"),
    ]);
    expect(result.verdict).toBe("grounded");
    expect(result.perClaim[0]?.evidence[0]?.anchor).toBe("#^d4e1");
  });

  it("treats low-confidence support as unsupported (confidence gating)", async () => {
    const lowConfidence: Verifier = {
      id: "low",
      entail: (input) =>
        Promise.resolve(
          input.passages.map((passage) => ({
            passageIndex: passage.index,
            label: "supported" as const,
            confidence: 0.3,
          })),
        ),
    };
    const pipeline = new GroundingPipeline(fakeSearch([chunk("Loosely related text.", "#^x")]), lowConfidence, {
      knn: 5,
      decisiveMinConfidence: 0.5,
    });
    const result = await pipeline.verify("A specific claim about the project.");
    expect(result.perClaim[0]?.verdict).toBe("neutral");
    expect(result.verdict).toBe("refused");
  });

  it("withholds grounding when a distinctive claim term is absent from the evidence", async () => {
    // The stub "supports" any postgres claim, but the claim also names Kubernetes,
    // which is not in the passage — the precision guard must refuse to ground it.
    const pipeline = new GroundingPipeline(
      fakeSearch([chunk("We use Postgres as the primary store.", "#^d4e1")]),
      new StubVerifier(),
      { knn: 5 },
    );
    const result = await pipeline.verify("We run Postgres on Kubernetes.");
    expect(result.perClaim[0]?.verdict).toBe("neutral");
    expect(result.verdict).toBe("refused");
  });

  it("treats a timed-out verifier as unsupported", async () => {
    const slow: Verifier = {
      id: "slow",
      entail: (input) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                input.passages.map((passage) => ({
                  passageIndex: passage.index,
                  label: "supported" as const,
                  confidence: 0.9,
                })),
              ),
            200,
          ),
        ),
    };
    const pipeline = new GroundingPipeline(fakeSearch([chunk("Postgres note", "#^x")]), slow, {
      knn: 5,
      verifyTimeoutMs: 30,
    });
    const result = await pipeline.verify("We use Postgres.");
    expect(result.perClaim[0]?.verdict).toBe("neutral");
  });
});
