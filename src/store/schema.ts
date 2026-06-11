// Index database schema. Kept as inlined SQL (rather than a .sql asset) so it
// ships cleanly in the compiled dist/ output for `npx` distribution.

export const SCHEMA_VERSION = 1;

/**
 * Relational tables + indexes. Dimension-independent and idempotent
 * (`IF NOT EXISTS`), so it is safe to run on every open.
 */
export const RELATIONAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  note_id      INTEGER PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  mtime_ms     INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at   INTEGER NOT NULL
);

-- One row per chunk == the citation / evidence unit.
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id     INTEGER PRIMARY KEY,
  note_id      INTEGER NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  heading_path TEXT,
  block_id     TEXT,
  anchor       TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  char_start   INTEGER NOT NULL,
  char_end     INTEGER NOT NULL,
  text         TEXT NOT NULL,
  token_est    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_note  ON chunks(note_id);
CREATE INDEX IF NOT EXISTS idx_chunks_block ON chunks(path, block_id);

CREATE TABLE IF NOT EXISTS wikilinks (
  chunk_id      INTEGER NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  target_note   TEXT NOT NULL,
  target_anchor TEXT,
  alias         TEXT
);
CREATE INDEX IF NOT EXISTS idx_wikilinks_chunk  ON wikilinks(chunk_id);
CREATE INDEX IF NOT EXISTS idx_wikilinks_target ON wikilinks(target_note);
`;

/**
 * The vec0 virtual table holding chunk embeddings. Its column width is fixed at
 * creation time, so it is templated by the active embedding dimension and
 * rebuilt whenever the embedding provider (and thus the dimension) changes.
 */
export function vecSchemaSql(dim: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[${dim}]
);`;
}

/**
 * Fallback embedding table used when the sqlite-vec native extension can't be
 * loaded. KNN is brute-forced in JS over these blobs (slower, but it works).
 */
export const FALLBACK_VEC_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS vec_chunks_js (
  chunk_id  INTEGER PRIMARY KEY,
  embedding BLOB NOT NULL
);`;
