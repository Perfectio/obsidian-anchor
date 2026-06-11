import { AutoModelForSequenceClassification, AutoTokenizer, env } from "@huggingface/transformers";

import { logger } from "../util/logger.js";
import type { Verdict } from "./types.js";
import type { PassageJudgement, Verifier, VerifierInput } from "./verifier.js";

// Default is English. For non-English vaults, point this at a multilingual NLI
// ONNX model via ANCHOR_NLI_MODEL (label order is auto-detected from id2label).
const MODEL_ID = process.env.ANCHOR_NLI_MODEL ?? "Xenova/nli-deberta-v3-small";

// Narrowed runtime shapes for the transformers.js objects we use (the library's
// own generics are very broad).
type Tokenizer = (
  text: string | string[],
  opts: { text_pair: string | string[]; padding?: boolean; truncation?: boolean },
) => Promise<unknown>;
interface NliModel {
  (inputs: unknown): Promise<{ logits: { data: Float32Array; dims: number[] } }>;
  config: { id2label: Record<string, string> };
}
interface LoadedModel {
  tokenizer: Tokenizer;
  model: NliModel;
  labelIndex: Record<Verdict, number>;
}

/**
 * Local, no-API-key grounding verifier built on a cross-encoder NLI model. For
 * each (passage, claim) pair it reads the full entailment / contradiction /
 * neutral distribution — crucially, this distinguishes "contradicted" from
 * merely "unsupported", which similarity search alone cannot do.
 */
export class LocalVerifier implements Verifier {
  readonly id = "local-nli-deberta";
  private loaded: Promise<LoadedModel> | null = null;

  constructor(cacheDir?: string) {
    if (cacheDir) {
      env.cacheDir = cacheDir;
    }
  }

  private load(): Promise<LoadedModel> {
    if (this.loaded === null) {
      logger.info("Loading local NLI verifier (first run downloads the model)", { model: MODEL_ID });
      this.loaded = (async (): Promise<LoadedModel> => {
        try {
          const tokenizer = (await AutoTokenizer.from_pretrained(MODEL_ID)) as unknown as Tokenizer;
          const model = (await AutoModelForSequenceClassification.from_pretrained(
            MODEL_ID,
          )) as unknown as NliModel;
          return { tokenizer, model, labelIndex: resolveLabelIndex(model.config.id2label) };
        } catch (error) {
          this.loaded = null; // allow a retry on the next call
          throw new Error(
            `Failed to load the local NLI verifier '${MODEL_ID}'. It downloads on first use — check network access and disk space.`,
            { cause: error },
          );
        }
      })();
    }
    return this.loaded;
  }

  async entail(input: VerifierInput): Promise<PassageJudgement[]> {
    if (input.passages.length === 0) return [];
    const { tokenizer, model, labelIndex } = await this.load();

    // One (passage, claim) pair at a time. Batching pairs with padding produced
    // misaligned/incorrect labels in transformers.js (unrelated passages scored
    // as high-confidence contradictions), so we trade a little speed for
    // correctness — premise = the note passage, hypothesis = the claim.
    const judgements: PassageJudgement[] = [];
    for (const passage of input.passages) {
      const inputs = await tokenizer(passage.text, { text_pair: input.claim, truncation: true });
      const output = await model(inputs);
      judgements.push(judge(passage.index, softmax(Array.from(output.logits.data)), labelIndex));
    }
    return judgements;
  }
}

/** Maps the model's id2label to our Verdict indices, tolerant of label naming. */
function resolveLabelIndex(id2label: Record<string, string>): Record<Verdict, number> {
  const index: Partial<Record<Verdict, number>> = {};
  for (const [idx, label] of Object.entries(id2label)) {
    const lower = label.toLowerCase();
    const i = Number(idx);
    if (lower.includes("entail")) index.supported = i;
    else if (lower.includes("contradic")) index.contradicted = i;
    else if (lower.includes("neutral")) index.neutral = i;
  }
  if (
    index.supported === undefined ||
    index.contradicted === undefined ||
    index.neutral === undefined
  ) {
    throw new Error(`Unexpected NLI label set: ${JSON.stringify(id2label)}`);
  }
  return { supported: index.supported, contradicted: index.contradicted, neutral: index.neutral };
}

function judge(
  passageIndex: number,
  probs: number[],
  labelIndex: Record<Verdict, number>,
): PassageJudgement {
  const scored: { label: Verdict; confidence: number }[] = [
    { label: "supported", confidence: probs[labelIndex.supported] ?? 0 },
    { label: "contradicted", confidence: probs[labelIndex.contradicted] ?? 0 },
    { label: "neutral", confidence: probs[labelIndex.neutral] ?? 0 },
  ];
  const best = scored.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  return { passageIndex, label: best.label, confidence: best.confidence };
}

function softmax(values: number[]): number[] {
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((exp) => exp / sum);
}
