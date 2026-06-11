import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../container.js";
import type { ScoredChunk } from "../store/types.js";

const RESULT_SHAPE = {
  /** Ready-to-use Obsidian citation, e.g. "Projects/Auth.md#^k93a". */
  citation: z.string(),
  path: z.string(),
  anchor: z.string(),
  heading: z.string().nullable(),
  blockId: z.string().nullable(),
  /** Relevance score in 0..1 (cosine similarity). */
  score: z.number(),
  /** Verbatim chunk text (the citable evidence span). */
  quote: z.string(),
};

export function registerSearchNotes(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Semantic search over the Obsidian vault. Returns matching chunks, each with a precise " +
        "Obsidian citation (note path + heading/block anchor) and a relevance score. Use this to " +
        "find evidence, then verify_grounding before asserting anything as fact.",
      inputSchema: {
        query: z.string().min(1).max(1000),
        limit: z.number().int().min(1).max(50).optional(),
      },
      outputSchema: { results: z.array(z.object(RESULT_SHAPE)) },
    },
    async ({ query, limit }) => {
      if (ctx.indexing) await ctx.indexing;
      const hits = await ctx.search.search(query, limit ?? ctx.config.knn);
      const payload = { results: hits.map(toResult) };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );
}

function toResult(chunk: ScoredChunk): z.infer<z.ZodObject<typeof RESULT_SHAPE>> {
  return {
    citation: `${chunk.notePath}${chunk.anchor}`,
    path: chunk.notePath,
    anchor: chunk.anchor,
    heading: chunk.headingPath,
    blockId: chunk.blockId,
    score: Math.round(chunk.score * 1000) / 1000,
    quote: chunk.text.replace(/\r/g, ""),
  };
}
