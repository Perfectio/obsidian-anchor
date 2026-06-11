// Grounding verification model.

/** Per-claim relationship between a claim and the user's notes. */
export type Verdict = "supported" | "contradicted" | "neutral";

/** Overall judgement for an answer. */
export type OverallVerdict = "grounded" | "flagged" | "refused";

export interface Claim {
  id: number;
  text: string;
}

export interface Evidence {
  path: string;
  anchor: string;
  blockId: string | null;
  heading: string | null;
  /** Verbatim chunk text supporting (or refuting) the claim. */
  quote: string;
  /** Entailment confidence for this passage (0..1). */
  score: number;
}

export interface PerClaimVerdict {
  claim: string;
  verdict: Verdict;
  /** 0..1 grounding score for this claim (support confidence; 0 if not supported). */
  score: number;
  evidence: Evidence[];
}

export interface GroundingResult {
  /** True only when every claim is solidly supported (and none contradicted). */
  grounded: boolean;
  /** Aggregate grounding score 0..1. */
  score: number;
  verdict: OverallVerdict;
  /** Human-readable one-line summary. */
  summary: string;
  perClaim: PerClaimVerdict[];
  /** Claims the notes do not support (unsupported or contradicted). */
  refusedClaims: string[];
}
