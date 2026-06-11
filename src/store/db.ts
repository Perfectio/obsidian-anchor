import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { logger } from "../util/logger.js";
import { FALLBACK_VEC_SCHEMA_SQL, RELATIONAL_SCHEMA_SQL, SCHEMA_VERSION, vecSchemaSql } from "./schema.js";

export type Db = Database.Database;

/** Which vector store backend is in use. */
export type VectorBackend = "native" | "fallback";

export interface OpenedDb {
  db: Db;
  vectorBackend: VectorBackend;
}

export interface OpenDbOptions {
  /** File path to the index database, or ":memory:" for tests. */
  path: string;
  /** Identifier of the active embedding provider (e.g. "local-minilm"). */
  embeddingModel: string;
  /** Embedding dimensionality; fixes the vec0 column width. */
  dim: number;
}

const IN_MEMORY = ":memory:";

/**
 * Opens and migrates the Anchor index database. It tries to load the sqlite-vec
 * native extension; if that fails on this platform, it falls back to a pure-JS
 * brute-force vector store so Anchor still works (just slower on large vaults).
 */
export function openDb(options: OpenDbOptions): OpenedDb {
  const db = new Database(options.path);

  let vectorBackend: VectorBackend = "native";
  try {
    sqliteVec.load(db);
    const probe = db.prepare("SELECT vec_version() AS v").get() as { v: string } | undefined;
    if (!probe?.v) throw new Error("vec_version() returned no value after load");
    logger.debug("Vector extension ready", { vecVersion: probe.v });
  } catch (error) {
    vectorBackend = "fallback";
    logger.warn(
      "sqlite-vec native extension unavailable; using the pure-JS vector fallback (slower on large vaults)",
      { detail: error instanceof Error ? error.message : String(error) },
    );
  }

  if (options.path !== IN_MEMORY) {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  migrate(db, options, vectorBackend);
  return { db, vectorBackend };
}

function readMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function writeMeta(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

function migrate(db: Db, options: OpenDbOptions, backend: VectorBackend): void {
  db.exec(RELATIONAL_SCHEMA_SQL);

  const prevDim = readMeta(db, "embedding_dim");
  const prevModel = readMeta(db, "embedding_model");
  const dimChanged = prevDim !== undefined && Number(prevDim) !== options.dim;
  const modelChanged = prevModel !== undefined && prevModel !== options.embeddingModel;

  if (dimChanged || modelChanged) {
    logger.warn(
      "Embedding configuration changed; rebuilding the vector index and clearing the stored index (a re-index is required).",
      { prevModel, prevDim, model: options.embeddingModel, dim: options.dim },
    );
    db.exec("DROP TABLE IF EXISTS vec_chunks;");
    db.exec("DROP TABLE IF EXISTS vec_chunks_js;");
    // Stored chunks reference embeddings that no longer match the active model;
    // clear them so the next indexing pass rebuilds everything consistently.
    db.exec("DELETE FROM chunks; DELETE FROM notes;");
  }

  db.exec(backend === "native" ? vecSchemaSql(options.dim) : FALLBACK_VEC_SCHEMA_SQL);

  writeMeta(db, "schema_version", String(SCHEMA_VERSION));
  writeMeta(db, "embedding_model", options.embeddingModel);
  writeMeta(db, "embedding_dim", String(options.dim));
}
