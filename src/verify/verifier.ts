import type { Verdict } from "./types.js";

/** A candidate passage to check a claim against. */
export interface VerifierPassage {
  index: number;
  path: string;
  anchor: string;
  text: string;
}

export interface VerifierInput {
  claim: string;
  passages: VerifierPassage[];
}

export interface PassageJudgement {
  passageIndex: number;
  label: Verdict;
  /** Confidence in `label` (0..1). */
  confidence: number;
}

/**
 * Pluggable entailment backend. The default is a local NLI model (no API key);
 * an Anthropic-backed verifier is a drop-in accuracy upgrade. Both judge the
 * narrow, closed question "does this passage support / contradict this claim?"
 * — which is far more stable than open generation (the defense against the
 * "verifier also hallucinates" critique).
 */
export interface Verifier {
  readonly id: string;
  entail(input: VerifierInput): Promise<PassageJudgement[]>;
}
