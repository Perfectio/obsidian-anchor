import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { type AnchorConfig, type ConfigOverrides, resolveConfig } from "./config.js";
import { SafeEditService } from "./edit/safeEdit.js";
import { LocalEmbeddingProvider } from "./embeddings/local.js";
import { OpenAIEmbeddingProvider } from "./embeddings/openai.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";
import { Indexer } from "./index/indexer.js";
import { ChunkStore } from "./store/chunkStore.js";
import { type Db, openDb } from "./store/db.js";
import { SearchService } from "./store/search.js";
import { VectorStore } from "./store/vectorStore.js";
import { logger } from "./util/logger.js";
import { AnthropicVerifier } from "./verify/anthropic.js";
import { LocalVerifier } from "./verify/localVerifier.js";
import { GroundingPipeline } from "./verify/pipeline.js";
import type { Verifier } from "./verify/verifier.js";

/** Wired-up application services bound to a single vault. */
export interface AppContext {
  config: AnchorConfig;
  db: Db;
  embeddings: EmbeddingProvider;
  verifier: Verifier;
  chunkStore: ChunkStore;
  vectorStore: VectorStore;
  indexer: Indexer;
  search: SearchService;
  grounding: GroundingPipeline;
  safeEdit: SafeEditService;
  /**
   * Resolves when the initial background index pass completes. Set by the server
   * entry point; vault-backed tools await it so early calls don't see an empty
   * index. Undefined in tests that index synchronously.
   */
  indexing?: Promise<void>;
}

/** Injectable overrides (tests swap providers; the CLI passes config + reindex). */
export interface ContextOverrides {
  embeddings?: EmbeddingProvider;
  verifier?: Verifier;
  /** Runtime config overrides (CLI flags). */
  config?: ConfigOverrides;
  /** Delete the existing index first to force a full rebuild. */
  reindex?: boolean;
}

/**
 * Composition root: instantiates the store, providers, and services for a vault.
 * Tools never construct providers directly — they receive an {@link AppContext}.
 */
export function createContext(vaultPath: string, overrides: ContextOverrides = {}): AppContext {
  const config = resolveConfig(vaultPath, overrides.config);
  mkdirSync(dirname(config.dbPath), { recursive: true });
  if (overrides.reindex) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${config.dbPath}${suffix}`, { force: true });
    }
  }

  const embeddings = overrides.embeddings ?? createDefaultEmbeddings(config);
  const verifier = overrides.verifier ?? createDefaultVerifier(config.modelCacheDir);
  const { db, vectorBackend } = openDb({
    path: config.dbPath,
    embeddingModel: embeddings.id,
    dim: embeddings.dim,
  });
  const chunkStore = new ChunkStore(db);
  const vectorStore = new VectorStore(db, vectorBackend);
  const indexer = new Indexer(vaultPath, db, chunkStore, vectorStore, embeddings);
  const search = new SearchService(embeddings, vectorStore, chunkStore);
  const grounding = new GroundingPipeline(search, verifier, {
    knn: config.knn,
    thresholds: { grounded: config.grounded, refuse: config.refuse },
    decisiveMinConfidence: config.decisiveMinConfidence,
    evidenceMinScore: config.evidenceMinScore,
    verifyTimeoutMs: config.verifyTimeoutMs,
  });
  const safeEdit = new SafeEditService(vaultPath, indexer);

  return {
    config,
    db,
    embeddings,
    verifier,
    chunkStore,
    vectorStore,
    indexer,
    search,
    grounding,
    safeEdit,
  };
}

/**
 * Selects the embedding provider. Local by default (privacy-first); OpenAI only
 * when explicitly opted in via ANCHOR_EMBEDDING=openai (notes are then sent to
 * the OpenAI API).
 */
function createDefaultEmbeddings(config: AnchorConfig): EmbeddingProvider {
  if (process.env.ANCHOR_EMBEDDING === "openai") {
    logger.info("Using OpenAI embeddings (notes are sent to the OpenAI API)");
    return new OpenAIEmbeddingProvider();
  }
  return new LocalEmbeddingProvider(config.modelCacheDir);
}

/**
 * Selects the grounding verifier: Anthropic (Haiku) when an API key is present,
 * otherwise the local NLI verifier. Force local with ANCHOR_VERIFIER=local.
 */
function createDefaultVerifier(modelCacheDir: string): Verifier {
  if (process.env.ANCHOR_VERIFIER !== "local" && process.env.ANTHROPIC_API_KEY) {
    logger.info("Using Anthropic verifier (ANTHROPIC_API_KEY detected)");
    return new AnthropicVerifier();
  }
  logger.info("Using local NLI verifier; set ANTHROPIC_API_KEY for higher accuracy");
  return new LocalVerifier(modelCacheDir);
}
