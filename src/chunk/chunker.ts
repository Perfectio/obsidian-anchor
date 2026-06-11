import { extractBlockId, extractWikilinks, isFence, matchHeading } from "./markdown.js";
import type { Chunk, ObsidianMeta } from "./types.js";

interface HeadingFrame {
  level: number;
  text: string;
}

// Matches a leading YAML frontmatter block so it can be excluded from chunk text
// while keeping absolute file offsets intact for the body.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

// Upper bound on chunk size. all-MiniLM-L6-v2 truncates at ~256 tokens (~1k
// chars for English); oversized blocks are split so no content is silently lost.
const MAX_CHUNK_CHARS = 1000;

/**
 * Splits a note into chunks — Anchor's citation/evidence units.
 *
 * The unit is a blank-line-separated block (paragraph, list group, table, or
 * fenced code), which matches how Obsidian attaches `^block-id`s. Oversized
 * blocks are further split to fit the embedding model. Each chunk carries the
 * most precise anchor available (block id > enclosing heading > synthetic line
 * marker). Heading lines are not emitted as chunks; they build the breadcrumb.
 */
export function chunkNote(path: string, content: string): Chunk[] {
  const chunks: Chunk[] = [];
  const headingStack: HeadingFrame[] = [];

  const frontmatter = FRONTMATTER_RE.exec(content);
  const bodyStart = frontmatter ? frontmatter[0].length : 0;

  let bufStart = -1;
  let bufLines: string[] = [];
  let inFence = false;

  const pushChunk = (text: string, start: number): void => {
    const blockId = extractBlockId(text);
    const meta: ObsidianMeta = {
      path,
      headingPath: headingStack.length > 0 ? headingStack.map((h) => h.text).join(" > ") : null,
      blockId,
      anchor: resolveAnchor(blockId, headingStack, chunks.length),
      wikilinks: extractWikilinks(text),
    };
    chunks.push({
      text,
      ordinal: chunks.length,
      charStart: start,
      charEnd: start + text.length,
      tokenEst: Math.ceil(text.length / 4),
      meta,
    });
  };

  const flush = (): void => {
    if (bufLines.length === 0) return;
    const text = bufLines.join("\n");
    const start = bufStart;
    bufLines = [];
    bufStart = -1;
    if (text.trim() === "") return;
    // Tables confuse the NLI verifier when kept whole (rows blur together), so
    // emit one chunk per row.
    if (isTable(text)) {
      for (const row of tableRows(text, start)) pushChunk(row.text, row.start);
      return;
    }
    for (const piece of splitBlock(text, start)) {
      pushChunk(piece.text, piece.start);
    }
  };

  // Index frontmatter that carries aliases/tags so a note is findable by them.
  const frontmatterText = frontmatter?.[0];
  if (frontmatterText !== undefined && /(^|\n)(aliases|tags)\s*:/i.test(frontmatterText)) {
    pushChunk(frontmatterText, 0);
  }

  let offset = bodyStart;
  for (const line of content.slice(bodyStart).split("\n")) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the "\n" that split removed

    if (isFence(line)) {
      if (inFence) {
        bufLines.push(line);
        inFence = false;
        flush();
      } else {
        flush();
        inFence = true;
        bufStart = lineStart;
        bufLines.push(line);
      }
      continue;
    }

    if (inFence) {
      if (bufStart === -1) bufStart = lineStart;
      bufLines.push(line);
      continue;
    }

    const heading = matchHeading(line);
    if (heading) {
      flush();
      while (headingStack.length > 0) {
        const top = headingStack[headingStack.length - 1];
        if (top === undefined || top.level < heading.level) break;
        headingStack.pop();
      }
      headingStack.push(heading);
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    if (bufStart === -1) bufStart = lineStart;
    bufLines.push(line);
  }
  flush();

  return chunks;
}

interface Piece {
  text: string;
  start: number;
}

/** Splits an oversized block into <= MAX_CHUNK_CHARS pieces on line/word boundaries. */
function splitBlock(text: string, start: number): Piece[] {
  if (text.length <= MAX_CHUNK_CHARS) return [{ text, start }];

  const pieces: Piece[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + MAX_CHUNK_CHARS, text.length);
    if (end < text.length) {
      // Back off to the last newline or space so we don't cut mid-word.
      const window = text.slice(pos, end);
      const newline = window.lastIndexOf("\n");
      const space = window.lastIndexOf(" ");
      const boundary = newline > MAX_CHUNK_CHARS / 2 ? newline : space;
      if (boundary > 0) end = pos + boundary + 1;
    }
    const piece = text.slice(pos, end);
    if (piece.trim() !== "") pieces.push({ text: piece, start: start + pos });
    pos = end;
  }
  return pieces;
}

const TABLE_SEPARATOR_RE = /^\|[\s:|-]+\|?$/;

function isTable(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length < 2) return false;
  const pipeLines = lines.filter((line) => line.trim().startsWith("|")).length;
  return pipeLines >= 2 && pipeLines >= lines.length - 1;
}

/** Splits a markdown table into one chunk per row (separator row dropped), offset-exact. */
function tableRows(text: string, start: number): Piece[] {
  const rows: Piece[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = start + offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || TABLE_SEPARATOR_RE.test(trimmed)) continue;
    rows.push({ text: line, start: lineStart });
  }
  return rows;
}

function resolveAnchor(blockId: string | null, stack: HeadingFrame[], ordinal: number): string {
  if (blockId) return `#^${blockId}`;
  const top = stack[stack.length - 1];
  if (top) return `#${top.text}`;
  return `#L${ordinal}`;
}
