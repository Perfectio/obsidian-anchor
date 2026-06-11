import type { Claim } from "./types.js";

interface SentenceSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}
interface SegmenterCtor {
  new (locale: string, options: { granularity: "sentence" }): SentenceSegmenter;
}

/**
 * Splits a free-text answer into atomic, individually-verifiable claims.
 *
 * Deliberately conservative: it prefers a few well-formed claims over many
 * fragments (over-splitting hurts grounding accuracy). No model is used — the
 * built-in sentence segmenter plus light heuristics.
 */
export function decompose(text: string): Claim[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  const claims: Claim[] = [];
  for (const sentence of segmentSentences(trimmed)) {
    for (const clause of splitConjunctions(sentence.trim())) {
      const cleaned = clause.trim();
      if (isVerifiable(cleaned)) {
        claims.push({ id: claims.length, text: cleaned });
      }
    }
  }

  // Fallback: a terse, punctuation-free line is still a claim worth checking.
  if (claims.length === 0) claims.push({ id: 0, text: trimmed });
  return claims;
}

function segmentSentences(text: string): string[] {
  const ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (ctor) {
    return Array.from(new ctor("en", { granularity: "sentence" }).segment(text), (s) => s.segment);
  }
  // Fallback for runtimes without Intl.Segmenter.
  return text.split(/(?<=[.!?])\s+/);
}

function isVerifiable(sentence: string): boolean {
  if (sentence.length < 3) return false;
  if (sentence.endsWith("?")) return false; // questions assert nothing
  return sentence.split(/\s+/).filter(Boolean).length >= 2;
}

// Common verbs/copulas — enough to tell a clause from a fragment in note prose.
const VERBS = new Set([
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
  "use", "uses", "used", "using", "have", "has", "had",
  "run", "runs", "ran", "running", "deploy", "deploys", "deployed",
  "cost", "costs", "lead", "leads", "led", "support", "supports", "supported",
  "require", "requires", "required", "include", "includes", "included",
  "offer", "offers", "offered", "generate", "generates", "generated",
  "schedule", "schedules", "scheduled", "send", "sends", "sent",
  "work", "works", "worked", "choose", "chooses", "chose", "chosen",
  "add", "adds", "added", "hash", "hashes", "hashed", "store", "stores", "stored",
  "expire", "expires", "expired", "encrypt", "encrypts", "encrypted",
  "slip", "slips", "slipped", "ship", "ships", "shipped", "build", "builds", "built",
  "handle", "handles", "handled", "process", "processes", "processed",
  "collect", "collects", "collected", "limit", "limits", "limited",
  "make", "makes", "made", "provide", "provides", "provided", "lives", "live",
]);

function hasVerb(clause: string): boolean {
  return (clause.match(/[A-Za-z'-]+/g) ?? []).some((word) => VERBS.has(word.toLowerCase()));
}

/** The leading "subject + verb" of a clause, e.g. "We use ..." → "We use". */
function subjectVerbPrefix(clause: string): string | null {
  const words = clause.split(/\s+/);
  for (let i = 0; i < words.length; i += 1) {
    const bare = (words[i] ?? "").replace(/[^A-Za-z'-]/g, "").toLowerCase();
    if (VERBS.has(bare)) return words.slice(0, i + 1).join(" ");
  }
  return null;
}

/**
 * Splits a coordinated sentence ("We use Redis for caching and Stripe for
 * payments") into independently-verifiable clauses, distributing the leading
 * subject+verb to any verbless fragment. Conservative: if a clean clause can't
 * be formed it keeps the sentence whole. Splitting can only make grounding
 * harder (every clause must ground on its own), never invent a false grounding.
 */
function splitConjunctions(sentence: string): string[] {
  const parts = sentence
    .split(/\s*,?\s+and\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return [sentence];

  const prefix = subjectVerbPrefix(parts[0] ?? "");
  const clauses: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    let clause = parts[i] ?? "";
    if (i > 0 && !hasVerb(clause)) {
      if (prefix === null) return [sentence]; // can't repair the fragment → don't split
      clause = `${prefix} ${clause}`;
    }
    if (!hasVerb(clause)) return [sentence]; // still not a clause → abort the split
    clauses.push(clause);
  }
  return clauses;
}
