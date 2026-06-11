// Deterministic Obsidian markdown extraction helpers (no LLM).
//
// These power the chunker. For the v1 milestone they are intentionally
// line/regex based; a remark-based hardening pass (robust fenced-code handling,
// nested structures) is planned for week 2.

import type { WikiLink } from "./types.js";

// [[note]] | [[note#^block]] | [[note#Heading]] | [[note|alias]]
const WIKILINK_RE = /\[\[([^\]|#]+)(#[^\]|]+)?(\|[^\]]+)?\]\]/g;
// trailing ^block-id on a block's last line
const BLOCK_ID_RE = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
const FENCE_RE = /^(?:```|~~~)/;

export function extractWikilinks(text: string): WikiLink[] {
  const links: WikiLink[] = [];
  for (const match of text.matchAll(WIKILINK_RE)) {
    const targetNote = (match[1] ?? "").trim();
    if (targetNote === "") continue;
    const targetAnchor = match[2] ?? null;
    const aliasGroup = match[3];
    links.push({
      targetNote,
      targetAnchor,
      alias: aliasGroup ? aliasGroup.slice(1) : null,
    });
  }
  return links;
}

/** Returns the block id (caret stripped) declared at the end of a block, if any. */
export function extractBlockId(blockText: string): string | null {
  const lines = blockText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    const match = BLOCK_ID_RE.exec(line);
    return match ? (match[1] ?? null) : null;
  }
  return null;
}

export interface HeadingMatch {
  level: number;
  text: string;
}

export function matchHeading(line: string): HeadingMatch | null {
  const match = HEADING_RE.exec(line);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  return { level: match[1].length, text: match[2].trim() };
}

export function isFence(line: string): boolean {
  return FENCE_RE.test(line.trimStart());
}
