// Core chunk model. A "chunk" is Anchor's citation/evidence unit: a span of a
// note that carries the most precise Obsidian anchor available so it can be
// cited natively (note.md#^block-id), not just by file name.

export interface WikiLink {
  /** Target note name as written, e.g. "[[Projects/Auth]]" -> "Projects/Auth". */
  targetNote: string;
  /** In-note target, e.g. "[[note#^blk]]" -> "#^blk"; null when absent. */
  targetAnchor: string | null;
  /** Display alias, e.g. "[[note|Auth]]" -> "Auth"; null when absent. */
  alias: string | null;
}

export interface ObsidianMeta {
  /** Vault-relative POSIX path of the source note. */
  path: string;
  /** Breadcrumb of enclosing headings, e.g. "Auth > Decisions"; null at root. */
  headingPath: string | null;
  /** Explicit block id (caret stripped), e.g. "k93a"; null when none. */
  blockId: string | null;
  /** Canonical citation anchor: "#^id" | "#Heading" | "#L{ordinal}". */
  anchor: string;
  /** Wikilinks found within the chunk. */
  wikilinks: WikiLink[];
}

export interface Chunk {
  /** Chunk markdown (what gets embedded and quoted as evidence). */
  text: string;
  /** Zero-based position within the source note. */
  ordinal: number;
  /** Inclusive start offset into the source file (for exact quoting / safe_edit). */
  charStart: number;
  /** Exclusive end offset into the source file. */
  charEnd: number;
  /** Rough token estimate (chars/4); used for packing, not exact tokenization. */
  tokenEst: number;
  meta: ObsidianMeta;
}
