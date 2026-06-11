// End-to-end grounding eval: the WHOLE pipeline (retrieve + verify) over a real
// indexed vault — not the verifier in isolation. This is the honest measure,
// because a retrieval miss makes Anchor wrongly REFUSE a true claim (a false
// refusal — the worst failure), which the verifier-only eval cannot see.

import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createContext } from "../src/container.js";
import { LocalEmbeddingProvider } from "../src/embeddings/local.js";
import { OpenAIEmbeddingProvider } from "../src/embeddings/openai.js";
import { AnthropicVerifier } from "../src/verify/anthropic.js";
import { LocalVerifier } from "../src/verify/localVerifier.js";

interface E2EItem {
  claim: string;
  expected: "grounded" | "refused";
  /** Failure-mode tag for the per-mode breakdown (e.g. "numeric-mismatch"). */
  mode?: string;
  note?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// Regression gates. Grounding precision is the core promise: Anchor must NEVER
// ground an unsupported claim, so that gate is absolute (zero false groundings).
// Wrongly refusing a true claim is the next-worst failure.
const GROUNDING_PRECISION_GATE = 1.0;
const FALSE_REFUSAL_GATE = 0.15;
const REFUSAL_RECALL_GATE = 0.9;

function loadDataset(path: string): E2EItem[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as E2EItem);
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  // Optional args: <vaultPath> <datasetPath> (default to the English fixture set).
  const vault = process.argv[2] ? resolve(process.argv[2]) : join(HERE, "fixtures", "vault");
  const datasetPath = process.argv[3] ? resolve(process.argv[3]) : join(HERE, "e2e-dataset.jsonl");
  rmSync(join(vault, ".anchor"), { recursive: true, force: true }); // fresh index

  // Backends selectable via ANCHOR_EMBEDDING / ANCHOR_VERIFIER (default: local).
  const embeddings =
    process.env.ANCHOR_EMBEDDING === "openai"
      ? new OpenAIEmbeddingProvider()
      : new LocalEmbeddingProvider();
  const verifier =
    process.env.ANCHOR_VERIFIER === "anthropic" ? new AnthropicVerifier() : new LocalVerifier();
  const ctx = createContext(vault, { embeddings, verifier });
  process.stderr.write("Indexing fixture vault with local models...\n");
  await ctx.indexer.indexAll();

  const items = loadDataset(datasetPath);
  let groundedTotal = 0;
  let groundedHit = 0;
  let refusedTotal = 0;
  let refusedHit = 0;
  let predictedGrounded = 0;
  let predictedGroundedCorrect = 0;
  const rows: string[] = [];
  const byMode = new Map<string, { correct: number; total: number }>();

  for (const item of items) {
    const result = await ctx.grounding.verify(item.claim);
    // "flagged" returns supporting evidence (it is not a refusal); only a hard
    // "refused" counts as a refusal.
    const predicted: "grounded" | "refused" = result.verdict === "refused" ? "refused" : "grounded";

    if (item.expected === "grounded") {
      groundedTotal += 1;
      if (predicted === "grounded") groundedHit += 1;
    } else {
      refusedTotal += 1;
      if (predicted === "refused") refusedHit += 1;
    }
    if (predicted === "grounded") {
      predictedGrounded += 1;
      if (item.expected === "grounded") predictedGroundedCorrect += 1;
    }

    const mark = predicted === item.expected ? "OK  " : "MISS";
    rows.push(
      `  ${mark} expected=${item.expected.padEnd(8)} got=${result.verdict.padEnd(8)} ${item.claim}`,
    );

    const mode = item.mode ?? "untagged";
    const stat = byMode.get(mode) ?? { correct: 0, total: 0 };
    stat.total += 1;
    if (predicted === item.expected) stat.correct += 1;
    byMode.set(mode, stat);
  }
  ctx.db.close();

  const recall = groundedTotal > 0 ? groundedHit / groundedTotal : 1;
  const refusalRecall = refusedTotal > 0 ? refusedHit / refusedTotal : 1;
  const groundingPrecision = predictedGrounded > 0 ? predictedGroundedCorrect / predictedGrounded : 1;

  const report = [
    "",
    "Anchor END-TO-END grounding eval (retrieve + verify, local backend)",
    `  items                  ${String(items.length)}`,
    `  grounding recall       ${fmtPct(recall)}   (true claims correctly grounded)`,
    `  false-refusal rate     ${fmtPct(1 - recall)}   (true claims wrongly refused — the worst failure)`,
    `  refusal recall         ${fmtPct(refusalRecall)}   (unsupported claims correctly refused)`,
    `  grounding precision    ${fmtPct(groundingPrecision)}   (of grounded claims, fraction truly supported)`,
    "",
    "  by failure mode (correct/total):",
    ...[...byMode.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([mode, stat]) => `    ${mode.padEnd(22)} ${String(stat.correct)}/${String(stat.total)}`),
    "",
    ...rows,
    "",
  ];
  process.stdout.write(`${report.join("\n")}\n`);

  if (
    groundingPrecision < GROUNDING_PRECISION_GATE ||
    1 - recall > FALSE_REFUSAL_GATE ||
    refusalRecall < REFUSAL_RECALL_GATE
  ) {
    process.stderr.write(
      `FAIL: grounding precision ${fmtPct(groundingPrecision)} (gate >= ${fmtPct(GROUNDING_PRECISION_GATE)}), ` +
        `false-refusal ${fmtPct(1 - recall)} (gate <= ${fmtPct(FALSE_REFUSAL_GATE)}), ` +
        `refusal recall ${fmtPct(refusalRecall)} (gate >= ${fmtPct(REFUSAL_RECALL_GATE)})\n`,
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`E2E eval failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
