import type { GroundingResult, OverallVerdict, PerClaimVerdict, Verdict } from "./types.js";

export interface Thresholds {
  /** Per-claim score at/above which a claim counts as solidly grounded. */
  grounded: number;
  /** Aggregate score below which the whole answer is refused. */
  refuse: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { grounded: 0.8, refuse: 0.5 };

/** Maps a per-claim label + confidence to a 0..1 grounding score. */
export function claimScore(verdict: Verdict, confidence: number): number {
  // Only positive support earns score; neutral (no evidence) and contradicted
  // (refuted by the notes) both score 0.
  return verdict === "supported" ? confidence : 0;
}

/**
 * Combines per-claim verdicts into an overall result. A single contradiction
 * caps the answer at "refused" — a note refuting a claim is worse than a claim
 * merely lacking support, and is the core "caught a lie" signal.
 */
export function aggregate(
  perClaim: PerClaimVerdict[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): GroundingResult {
  if (perClaim.length === 0) {
    return {
      grounded: false,
      score: 0,
      verdict: "refused",
      summary: "No verifiable claims were found in the text.",
      perClaim: [],
      refusedClaims: [],
    };
  }

  const mean = perClaim.reduce((sum, claim) => sum + claim.score, 0) / perClaim.length;
  const hasContradiction = perClaim.some((claim) => claim.verdict === "contradicted");
  const allGrounded = perClaim.every(
    (claim) => claim.verdict === "supported" && claim.score >= thresholds.grounded,
  );
  const refusedClaims = perClaim
    .filter((claim) => claim.verdict === "contradicted" || claim.score < thresholds.refuse)
    .map((claim) => claim.claim);

  let verdict: OverallVerdict;
  if (allGrounded && !hasContradiction) {
    verdict = "grounded";
  } else if (hasContradiction || mean < thresholds.refuse) {
    verdict = "refused";
  } else {
    verdict = "flagged";
  }

  return {
    grounded: verdict === "grounded",
    score: round(mean),
    verdict,
    summary: summarize(perClaim),
    perClaim,
    refusedClaims,
  };
}

function summarize(perClaim: PerClaimVerdict[]): string {
  const total = perClaim.length;
  const supported = perClaim.filter((claim) => claim.verdict === "supported").length;
  const contradicted = perClaim.filter((claim) => claim.verdict === "contradicted").length;
  const unsupported = perClaim.filter((claim) => claim.verdict === "neutral").length;

  const parts = [`${supported}/${total} claim(s) supported by your notes`];
  if (contradicted > 0) parts.push(`${contradicted} contradicted`);
  if (unsupported > 0) parts.push(`${unsupported} unsupported`);
  return `${parts.join("; ")}.`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
