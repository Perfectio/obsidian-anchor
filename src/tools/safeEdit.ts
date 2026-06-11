import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../container.js";

export function registerSafeEdit(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "safe_edit",
    {
      title: "Safe edit",
      description:
        "Edit a note by replacing an exact snippet. Called WITHOUT `confirm`, it returns a dry-run " +
        "diff and a confirmation token without touching the file. Call it again with the same arguments " +
        "plus `confirm` set to that token to apply the change — a rollback snapshot is saved and the note " +
        "is re-indexed. The token also rejects the edit if the note changed since the preview.",
      inputSchema: {
        path: z.string().min(1).max(1024),
        oldText: z.string().min(1).max(50_000),
        newText: z.string().max(50_000),
        confirm: z.string().optional(),
      },
      outputSchema: {
        mode: z.enum(["dry-run", "applied"]),
        path: z.string(),
        message: z.string(),
        diff: z.string().optional(),
        token: z.string().optional(),
        snapshot: z.string().optional(),
        reindexedChunks: z.number().nullable().optional(),
      },
    },
    async ({ path, oldText, newText, confirm }) => {
      if (ctx.indexing) await ctx.indexing;
      try {
        const result = await ctx.safeEdit.edit(path, oldText, newText, confirm);
        if (result.mode === "dry-run") {
          const payload = {
            mode: "dry-run" as const,
            path: result.path,
            diff: result.diff,
            token: result.token,
            message:
              "Dry run — review the diff. To apply, call safe_edit again with the same arguments plus " +
              `confirm: "${result.token}".`,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            structuredContent: payload,
          };
        }
        const payload = {
          mode: "applied" as const,
          path: result.path,
          snapshot: result.snapshot,
          reindexedChunks: result.reindexedChunks,
          message: `Applied. Rollback snapshot saved at ${result.snapshot}.`,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `safe_edit error: ${message}` }],
          structuredContent: { mode: "dry-run" as const, path, message: `Error: ${message}` },
          isError: true,
        };
      }
    },
  );
}
