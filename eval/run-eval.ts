// Grounding eval harness. Run with: npm run eval
//
// Loads a labeled dataset (claim + candidate passages + gold verdict), runs the
// verifier on each item, and reports the metrics that matter for a reliability
// tool — above all REFUSAL PRECISION: when Anchor refuses a claim, how often is
// the claim genuinely unsupported? Wrongly refusing a true claim is the worst
// failure, so this is the CI gate.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AnthropicVerifier } from "../src/verify/anthropic.js";
import { LocalVerifier } from "../src/verify/localVerifier.js";
import { pickDecisive } from "../src/verify/pipeline.js";
import type { Verdict } from "../src/verify/types.js";
import type { Verifier } from "../src/verify/verifier.js";

interface EvalItem {
  claim: string;
  passages: string[];
  gold: Verdict;
  note?: string;
}

interface Metrics {
  total: number;
  balancedAccuracy: number;
  refusalPrecision: number;
  groundingPrecision: number;
  contradictionPrecision: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// Refusal precision is the primary reliability metric and the CI gate. The local
// NLI backend measures ~0.84 on this (adversarial-heavy) set, so the gate is a
// regression FLOOR — not the target. The Anthropic verifier and a larger dataset
// aim for >= 0.90; raise this floor as those land.
const REFUSAL_PRECISION_GATE = 0.75;
const DECISIVE_MIN_CONFIDENCE = 0.5;

function loadDataset(): EvalItem[] {
  const raw = readFileSync(join(HERE, "dataset.jsonl"), "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .map((line) => JSON.parse(line) as EvalItem);
}

async function evaluate(verifier: Verifier, items: EvalItem[]): Promise<Metrics> {
  const labels: Verdict[] = ["supported", "contradicted", "neutral"];
  const correctByClass: Record<Verdict, number> = { supported: 0, contradicted: 0, neutral: 0 };
  const totalByClass: Record<Verdict, number> = { supported: 0, contradicted: 0, neutral: 0 };
  let refused = 0;
  let refusedCorrect = 0;
  let grounded = 0;
  let groundedCorrect = 0;
  let predictedContradicted = 0;
  let predictedContradictedCorrect = 0;
  const latencies: number[] = [];

  for (const item of items) {
    const passages = item.passages.map((text, index) => ({ index, path: "eval", anchor: "#x", text }));
    const start = performance.now();
    const judgements = await verifier.entail({ claim: item.claim, passages });
    latencies.push(performance.now() - start);

    const predicted = pickDecisive(judgements, DECISIVE_MIN_CONFIDENCE).label;
    totalByClass[item.gold] += 1;
    if (predicted === item.gold) correctByClass[item.gold] += 1;

    const predictedRefuse = predicted !== "supported";
    const goldRefuse = item.gold !== "supported";
    if (predictedRefuse) {
      refused += 1;
      if (goldRefuse) refusedCorrect += 1;
    } else {
      grounded += 1;
      if (!goldRefuse) groundedCorrect += 1;
    }
    if (predicted === "contradicted") {
      predictedContradicted += 1;
      if (item.gold === "contradicted") predictedContradictedCorrect += 1;
    }
  }

  const recalls = labels.map((label) =>
    totalByClass[label] > 0 ? correctByClass[label] / totalByClass[label] : 1,
  );
  latencies.sort((a, b) => a - b);
  const percentile = (p: number): number =>
    latencies.length === 0 ? 0 : (latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] ?? 0);

  return {
    total: items.length,
    balancedAccuracy: recalls.reduce((a, b) => a + b, 0) / labels.length,
    refusalPrecision: refused > 0 ? refusedCorrect / refused : 1,
    groundingPrecision: grounded > 0 ? groundedCorrect / grounded : 1,
    contradictionPrecision: predictedContradicted > 0 ? predictedContradictedCorrect / predictedContradicted : 1,
    latencyP50Ms: percentile(0.5),
    latencyP95Ms: percentile(0.95),
  };
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const items = loadDataset();
  const verifier =
    process.env.ANCHOR_VERIFIER === "anthropic" ? new AnthropicVerifier() : new LocalVerifier();
  process.stderr.write(`Evaluating ${String(items.length)} items with verifier '${verifier.id}'...\n`);

  const metrics = await evaluate(verifier, items);
  const report = [
    "",
    `Anchor grounding eval — verifier: ${verifier.id}`,
    `  items                  ${String(metrics.total)}`,
    `  balanced accuracy      ${fmtPct(metrics.balancedAccuracy)}`,
    `  refusal precision      ${fmtPct(metrics.refusalPrecision)}   (of refused claims, fraction truly unsupported)`,
    `  grounding precision    ${fmtPct(metrics.groundingPrecision)}   (of grounded claims, fraction truly supported)`,
    `  contradiction prec.    ${fmtPct(metrics.contradictionPrecision)}`,
    `  latency p50 / p95      ${metrics.latencyP50Ms.toFixed(0)}ms / ${metrics.latencyP95Ms.toFixed(0)}ms`,
    "",
  ];
  process.stdout.write(`${report.join("\n")}\n`);

  if (metrics.refusalPrecision < REFUSAL_PRECISION_GATE) {
    process.stderr.write(
      `FAIL: refusal precision ${fmtPct(metrics.refusalPrecision)} is below the gate ${fmtPct(REFUSAL_PRECISION_GATE)}\n`,
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Eval failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
