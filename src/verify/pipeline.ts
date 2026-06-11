import type { SearchService } from "../store/search.js";
import type { ScoredChunk } from "../store/types.js";
import { logger } from "../util/logger.js";
import { withTimeout } from "../util/timeout.js";
import { decompose } from "./decompose.js";
import { aggregate, claimScore, DEFAULT_THRESHOLDS, type Thresholds } from "./score.js";
import type { Evidence, GroundingResult, PerClaimVerdict, Verdict } from "./types.js";
import type { PassageJudgement, Verifier, VerifierPassage } from "./verifier.js";

export interface GroundingOptions {
  /** Candidate passages to retrieve per claim. */
  knn: number;
  thresholds?: Thresholds;
  /** Minimum confidence for a non-neutral judgement to be treated as decisive. */
  decisiveMinConfidence?: number;
  /** Minimum retrieval relevance for a passage to be judged by the verifier. */
  evidenceMinScore?: number;
  /** Max time for a single verifier call before the claim is treated as unverified. */
  verifyTimeoutMs?: number;
}

const DEFAULT_DECISIVE_MIN_CONFIDENCE = 0.5;
const DEFAULT_EVIDENCE_MIN_SCORE = 0.35;
const DEFAULT_VERIFY_TIMEOUT_MS = 30_000;

/**
 * The heart of Anchor: decompose an answer into claims, retrieve candidate
 * evidence for each (reusing search), have the verifier judge entailment, then
 * score and aggregate into a grounded / flagged / refused verdict.
 */
export class GroundingPipeline {
  constructor(
    private readonly search: SearchService,
    private readonly verifier: Verifier,
    private readonly options: GroundingOptions,
  ) {}

  async verify(answer: string, providedSources?: ScoredChunk[]): Promise<GroundingResult> {
    const claims = decompose(answer);
    const perClaim: PerClaimVerdict[] = [];
    for (const claim of claims) {
      const candidates = providedSources ?? (await this.search.search(claim.text, this.options.knn));
      perClaim.push(await this.judgeClaim(claim.text, candidates));
    }
    return aggregate(perClaim, this.options.thresholds ?? DEFAULT_THRESHOLDS);
  }

  private async judgeClaim(claimText: string, candidates: ScoredChunk[]): Promise<PerClaimVerdict> {
    // Only judge passages that are actually relevant to the claim. The NLI model
    // is unreliable on off-topic text (it can emit spurious high-confidence
    // contradictions), so a low-relevance passage must not be able to refute — or
    // support — a claim.
    const minScore = this.options.evidenceMinScore ?? DEFAULT_EVIDENCE_MIN_SCORE;
    const relevant = candidates.filter((chunk) => chunk.score >= minScore);
    if (relevant.length === 0) {
      return { claim: claimText, verdict: "neutral", score: 0, evidence: [] };
    }
    const passages: VerifierPassage[] = relevant.map((chunk, index) => ({
      index,
      path: chunk.notePath,
      anchor: chunk.anchor,
      text: cleanText(chunk.text),
    }));

    let judgements: PassageJudgement[];
    try {
      judgements = await withTimeout(
        this.verifier.entail({ claim: claimText, passages }),
        this.options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
        "verifier",
      );
    } catch (error) {
      logger.warn("Verifier failed or timed out; treating claim as unsupported", {
        claim: claimText,
        error: error instanceof Error ? error.message : String(error),
      });
      return { claim: claimText, verdict: "neutral", score: 0, evidence: [] };
    }

    const best = pickDecisive(
      judgements,
      this.options.decisiveMinConfidence ?? DEFAULT_DECISIVE_MIN_CONFIDENCE,
    );

    let label = best.label;
    let confidence = best.confidence;
    // Precision guard against entity-substitution false positives: only ground a
    // claim if its distinctive terms actually appear in the supporting passage.
    if (label === "supported" && !salientTermsPresent(claimText, passages[best.passageIndex]?.text ?? "")) {
      logger.debug("Withholding grounding: the claim's distinctive terms are absent from the evidence", {
        claim: claimText,
      });
      label = "neutral";
      confidence = 0;
    }

    const evidence = label === "neutral" ? [] : buildEvidence(label, judgements, relevant);

    return {
      claim: claimText,
      verdict: label,
      score: claimScore(label, confidence),
      evidence,
    };
  }
}

/**
 * The decisive judgement for a claim: the strongest non-neutral judgement that
 * clears `minConfidence`. If none does, the claim is treated as unsupported
 * (neutral) — a low-confidence "supported"/"contradicted" must not be enough to
 * ground or refute a claim.
 */
export function pickDecisive(judgements: PassageJudgement[], minConfidence: number): PassageJudgement {
  // Judgements arrive in retrieval-relevance order (most relevant first). The
  // most relevant passage that gives a confident non-neutral verdict decides — a
  // spurious verdict from a less-relevant passage must not override it.
  for (const judgement of judgements) {
    if (judgement.label !== "neutral" && judgement.confidence >= minConfidence) {
      return judgement;
    }
  }
  const first = judgements[0];
  return first === undefined
    ? { passageIndex: 0, label: "neutral", confidence: 0 }
    : { passageIndex: first.passageIndex, label: "neutral", confidence: first.confidence };
}

/** Strips trailing Obsidian block ids and carriage returns from passage text. */
function cleanText(text: string): string {
  return text.replace(/\r/g, "").replace(/\s*\^[A-Za-z0-9-]+\s*$/, "").trim();
}

/**
 * Precision guard against entity-substitution false positives. A small NLI model
 * can confidently "support" "We use MongoDB" from a passage that says PostgreSQL,
 * because it reasons topically. Anchor only grounds a claim when the claim's
 * distinctive terms — tech identifiers, acronyms, numbers, proper nouns — appear
 * in the supporting passage. Conservative by design: a false refusal is far safer
 * than a false grounding for a tool whose promise is "can't lie about your notes".
 */
function salientTermsPresent(claim: string, passage: string): boolean {
  const haystack = passage.toLowerCase();
  const words = haystack.match(/[a-z0-9]+/g) ?? [];
  for (const term of salientTerms(claim)) {
    const needle = term.toLowerCase();
    if (haystack.includes(needle)) continue;
    // Lenient stem match so "PostgreSQL" ↔ "Postgres" still counts as present.
    if (needle.length >= 5 && words.some((word) => word.length >= 4 && needle.includes(word))) {
      continue;
    }
    return false;
  }
  return true;
}

/** Distinctive terms in a claim: tech identifiers, acronyms, numbers, proper nouns. */
function salientTerms(claim: string): string[] {
  const tokens = claim.match(/[A-Za-z0-9][A-Za-z0-9.$:%+/-]*/g) ?? [];
  const terms: string[] = [];
  tokens.forEach((raw, index) => {
    const token = raw.replace(/[.$:%+/-]+$/, ""); // drop trailing punctuation ("10:00." → "10:00")
    if (token.length === 0) return;
    const hasDigit = /\d/.test(token);
    const camelCase = /[A-Z][a-z]*[A-Z]/.test(token); // PostgreSQL, MongoDB
    const acronym = /^[A-Z]{2,}$/.test(token); // JWT, AWS, EKS
    const midProperNoun = index > 0 && /^[A-Z][a-z]{2,}$/.test(token); // ...Redis, ...Cassandra
    if (hasDigit || camelCase || acronym || midProperNoun) terms.push(token);
  });
  return terms;
}

/** Collects the strongest passages that share the winning label as evidence. */
function buildEvidence(
  label: Verdict,
  judgements: PassageJudgement[],
  candidates: ScoredChunk[],
): Evidence[] {
  const evidence: Evidence[] = [];
  const matching = judgements
    .filter((judgement) => judgement.label === label && judgement.confidence >= 0.4)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  for (const judgement of matching) {
    const chunk = candidates[judgement.passageIndex];
    if (chunk === undefined) continue;
    evidence.push({
      path: chunk.notePath,
      anchor: chunk.anchor,
      blockId: chunk.blockId,
      heading: chunk.headingPath,
      quote: cleanText(chunk.text),
      score: Math.round(judgement.confidence * 1000) / 1000,
    });
  }
  return evidence;
}
