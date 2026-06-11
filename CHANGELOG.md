# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-06-10

### Added

- `search_notes`, `verify_grounding`, `cite`, and `safe_edit` MCP tools.
- Local-first grounding: in-process embeddings (all-MiniLM-L6-v2) + an NLI
  verifier (nli-deberta-v3-small) — no API key required.
- Optional Anthropic (Claude Haiku) verifier, auto-selected when
  `ANTHROPIC_API_KEY` is set.
- Obsidian-native citations: block ids, headings, and wikilinks.
- Incremental vault watching, background indexing, and graceful shutdown.
- Grounding eval harness: verifier-only (`npm run eval`) and end-to-end
  retrieve+verify (`npm run eval:e2e`), both CI-gated.
- Relevance-gated, relevance-ordered verification (a less-relevant passage can't
  override a more-relevant one) and table-aware chunking (table rows are chunked
  individually so the verifier doesn't blur them).
- Entity-substitution precision guard: a claim is grounded only when its
  distinctive terms (proper nouns, identifiers, numbers) appear in the cited
  evidence, so a topical look-alike ("we use MongoDB" against a Postgres note) is
  refused rather than falsely grounded.
- Grounding precision (zero false groundings) is a hard CI gate, enforced by an
  88-claim adversarial eval tagged by failure mode (entity substitution, numeric
  mismatch, temporal, negation, quantifier scope, conjunction, and more).
- Conjunction decomposition: a coordinated claim ("X and Y") is split and each
  half verified independently, so true multi-fact claims are no longer refused.
- Non-English vaults: configurable local models (`ANCHOR_EMBEDDING_MODEL` /
  `ANCHOR_NLI_MODEL`) plus a Korean eval (`npm run eval:ko`) on the API path.
- Robustness: prunes notes deleted while offline, snapshot-based note rollback
  (`restore_note`, itself undoable) with snapshot retention, a verification
  timeout, and a pure-JS vector fallback when sqlite-vec can't load.
- Runtime configuration via CLI flags (`--knn`, `--grounded-threshold`,
  `--refuse-threshold`, `--evidence-min-score`, `--verify-timeout-ms`,
  `--verifier`, `--embedding`, `--reindex`); frontmatter alias/tag indexing.
- Optional OpenAI embeddings (`--embedding openai`) and a `sources` parameter on
  `verify_grounding` to verify against passages you supply.

[Unreleased]: https://github.com/Perfectio/obsidian-anchor/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Perfectio/obsidian-anchor/releases/tag/v0.2.0
