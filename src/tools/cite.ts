import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../container.js";

const CITATION_SHAPE = {
  citation: z.string(),
  path: z.string(),
  anchor: z.string(),
  quote: z.string(),
  score: z.number(),
};

export function registerCite(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "cite",
    {
      title: "Cite",
      description:
        "Attach forced citations to a statement about the vault. Returns the supporting note " +
        "passages when the notes back the statement, or an honest 'no supporting notes found' " +
        "otherwise. Use this to ground any claim you make about the user's notes; if it is not " +
        "cited, do not state it as fact.",
      inputSchema: { claim: z.string().min(1).max(8000) },
      outputSchema: {
        cited: z.boolean(),
        statement: z.string(),
        citations: z.array(z.object(CITATION_SHAPE)),
        note: z.string(),
      },
    },
    async ({ claim }) => {
      if (ctx.indexing) await ctx.indexing;
      const result = await ctx.grounding.verify(claim);
      const citations = result.perClaim
        .filter((perClaim) => perClaim.verdict === "supported")
        .flatMap((perClaim) => perClaim.evidence)
        .map((evidence) => ({
          citation: `${evidence.path}${evidence.anchor}`,
          path: evidence.path,
          anchor: evidence.anchor,
          quote: evidence.quote,
          score: evidence.score,
        }));
      const contradicted = result.perClaim.some((perClaim) => perClaim.verdict === "contradicted");
      const cited = citations.length > 0 && result.verdict !== "refused";
      const note = cited
        ? `Supported by ${citations.length} note passage(s).`
        : contradicted
          ? "Your notes contradict this — do not state it as fact."
          : "No supporting notes found — do not state this as fact.";

      const payload = { cited, statement: claim, citations, note };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );
}
