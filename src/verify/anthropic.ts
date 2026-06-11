import Anthropic from "@anthropic-ai/sdk";

import { logger } from "../util/logger.js";
import type { Verdict } from "./types.js";
import type { PassageJudgement, Verifier, VerifierInput } from "./verifier.js";

// Haiku is a deliberate choice (locked in the plan): the verifier runs a narrow,
// high-volume, closed entailment classification where Haiku's speed/cost win —
// not an arbitrary downgrade of the default model.
const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = [
  "You are a strict grounding verifier.",
  "Given a CLAIM and a list of numbered PASSAGES from the user's notes, decide for EACH passage whether it",
  "SUPPORTS (entails) the claim, CONTRADICTS (refutes) it, or is NEUTRAL (unrelated or insufficient to decide).",
  "Judge ONLY from the passage text — never use outside knowledge.",
  "Return one judgement per passage with a confidence in [0,1].",
].join(" ");

// Raw JSON Schema (avoids coupling to any zod-helper version).
const OUTPUT_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      judgements: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            passageIndex: { type: "integer" },
            label: { type: "string", enum: ["supported", "contradicted", "neutral"] },
            confidence: { type: "number" },
          },
          required: ["passageIndex", "label", "confidence"],
        },
      },
    },
    required: ["judgements"],
  },
} as const;

// Minimal slice of the Anthropic client we depend on, so tests can inject a fake
// without a real API key.
export interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>): Promise<{ content: { type: string; text?: string }[] }>;
  };
}

/**
 * Anthropic-backed grounding verifier (Claude Haiku). Auto-selected when an API
 * key is present; the local NLI verifier is the no-key default. Same closed
 * entailment task, higher accuracy.
 */
export class AnthropicVerifier implements Verifier {
  readonly id = "anthropic-haiku";
  private readonly client: AnthropicLike;

  constructor(client?: AnthropicLike) {
    this.client = client ?? (new Anthropic() as unknown as AnthropicLike);
  }

  async entail(input: VerifierInput): Promise<PassageJudgement[]> {
    if (input.passages.length === 0) return [];

    const passageBlock = input.passages.map((p) => `[${String(p.index)}] ${p.text}`).join("\n\n");
    const userText = `CLAIM: ${input.claim}\n\nPASSAGES:\n${passageBlock}`;

    let judgements: RawJudgement[];
    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userText }],
        output_config: { format: OUTPUT_FORMAT },
      });
      judgements = parseJudgements(response.content);
    } catch (error) {
      // Conservative on failure: unverified => not grounded (neutral). The SDK
      // already retries transient 429/5xx, so this is for persistent failures.
      logger.warn("Anthropic verifier call failed; treating passages as neutral", {
        error: error instanceof Error ? error.message : String(error),
      });
      return input.passages.map((p) => neutral(p.index));
    }

    const byIndex = new Map<number, { label: Verdict; confidence: number }>();
    for (const judgement of judgements) {
      byIndex.set(judgement.passageIndex, {
        label: judgement.label,
        confidence: clamp01(judgement.confidence),
      });
    }
    return input.passages.map((passage) => {
      const judgement = byIndex.get(passage.index);
      return judgement === undefined
        ? neutral(passage.index)
        : { passageIndex: passage.index, label: judgement.label, confidence: judgement.confidence };
    });
  }
}

interface RawJudgement {
  passageIndex: number;
  label: Verdict;
  confidence: number;
}

const LABELS: ReadonlySet<string> = new Set<Verdict>(["supported", "contradicted", "neutral"]);

/** Extracts and validates the judgements array from the model's JSON response. */
function parseJudgements(content: { type: string; text?: string }[]): RawJudgement[] {
  const text = content.find((block) => block.type === "text" && typeof block.text === "string")?.text;
  if (text === undefined) return [];

  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) return [];
  const rawList = (parsed as { judgements?: unknown }).judgements;
  if (!Array.isArray(rawList)) return [];

  const out: RawJudgement[] = [];
  for (const item of rawList) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const passageIndex = record.passageIndex;
    const label = record.label;
    const confidence = record.confidence;
    if (typeof passageIndex === "number" && typeof label === "string" && LABELS.has(label)) {
      out.push({
        passageIndex,
        label: label as Verdict,
        confidence: typeof confidence === "number" ? confidence : 0,
      });
    }
  }
  return out;
}

function neutral(passageIndex: number): PassageJudgement {
  return { passageIndex, label: "neutral", confidence: 0 };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
