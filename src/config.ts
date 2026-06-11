import { join } from "node:path";

/** Resolved runtime configuration for an Anchor instance bound to one vault. */
export interface AnchorConfig {
  /** Absolute path to the Obsidian vault. */
  vaultPath: string;
  /** Path to the index database (under the vault's .anchor directory). */
  dbPath: string;
  /** Directory for cached embedding model weights. */
  modelCacheDir: string;
  /** Default number of nearest neighbours to retrieve. */
  knn: number;
  /** Per-claim score at/above which a claim is solidly grounded. */
  grounded: number;
  /** Aggregate score below which the whole answer is refused. */
  refuse: number;
  /** Minimum confidence for a non-neutral verdict to be treated as decisive. */
  decisiveMinConfidence: number;
  /** Minimum retrieval relevance for a passage to be judged by the verifier. */
  evidenceMinScore: number;
  /** Max time for a single verifier call before the claim is treated as unverified. */
  verifyTimeoutMs: number;
}

/** Runtime-tunable config fields (overridable via CLI flags). */
export type ConfigOverrides = Partial<
  Pick<
    AnchorConfig,
    "knn" | "grounded" | "refuse" | "decisiveMinConfidence" | "evidenceMinScore" | "verifyTimeoutMs"
  >
>;

const ANCHOR_DIR = ".anchor";

export function resolveConfig(vaultPath: string, overrides: ConfigOverrides = {}): AnchorConfig {
  return {
    vaultPath,
    dbPath: join(vaultPath, ANCHOR_DIR, "index.db"),
    modelCacheDir: join(vaultPath, ANCHOR_DIR, "models"),
    knn: 6,
    grounded: 0.8,
    refuse: 0.5,
    decisiveMinConfidence: 0.5,
    evidenceMinScore: 0.35,
    verifyTimeoutMs: 30_000,
    ...overrides,
  };
}
