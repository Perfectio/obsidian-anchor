import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../container.js";
import type { ScoredChunk } from "../store/types.js";

const EVIDENCE_SHAPE = {
  path: z.string(),
  anchor: z.string(),
  blockId: z.string().nullable(),
  heading: z.string().nullable(),
  quote: z.string(),
  score: z.number(),
};

const PER_CLAIM_SHAPE = {
  claim: z.string(),
  verdict: z.enum(["supported", "contradicted", "neutral"]),
  score: z.number(),
  evidence: z.array(z.object(EVIDENCE_SHAPE)),
};

export function registerVerifyGrounding(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "verify_grounding",
    {
      title: "Verify grounding",
      description:
        "Check whether a claim (or short answer) is actually supported by the user's notes. " +
        "Returns a grounding score 0-1 and a per-claim verdict (supported / contradicted / " +
        "neutral) with Obsidian-cited evidence, and lists claims the notes do not support. " +
        "Call this BEFORE asserting anything about the vault as fact; treat a refusal as " +
        "'this is not in the notes'. Optionally pass `sources` (note passages, e.g. from " +
        "search_notes) to verify against directly instead of retrieving.",
      inputSchema: {
        claim: z.string().min(1).max(8000),
        sources: z
          .array(z.object({ path: z.string(), anchor: z.string(), text: z.string().max(50_000) }))
          .max(50)
          .optional(),
      },
      outputSchema: {
        grounded: z.boolean(),
        score: z.number(),
        verdict: z.enum(["grounded", "flagged", "refused"]),
        summary: z.string(),
        perClaim: z.array(z.object(PER_CLAIM_SHAPE)),
        refusedClaims: z.array(z.string()),
      },
    },
    async ({ claim, sources }) => {
      if (ctx.indexing) await ctx.indexing;
      const provided = sources?.map((source, index) => toScoredChunk(source, index));
      const result = await ctx.grounding.verify(claim, provided);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: { ...result },
      };
    },
  );
}

function toScoredChunk(
  source: { path: string; anchor: string; text: string },
  index: number,
): ScoredChunk {
  return {
    chunkId: -1 - index,
    notePath: source.path,
    headingPath: null,
    blockId: null,
    anchor: source.anchor,
    ordinal: index,
    charStart: 0,
    charEnd: source.text.length,
    text: source.text,
    distance: 0,
    score: 1,
  };
}
