import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../container.js";

export function registerRestoreNote(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "restore_note",
    {
      title: "Restore note",
      description:
        "Roll a note back to a rollback snapshot saved by safe_edit (pass the snapshot path from " +
        "a previous safe_edit result). The current content is snapshotted first, so the restore is " +
        "itself undoable, and the note is re-indexed.",
      inputSchema: {
        path: z.string().min(1).max(1024),
        snapshot: z.string().min(1).max(1024),
      },
      outputSchema: {
        path: z.string(),
        restoredFrom: z.string(),
        preRestoreSnapshot: z.string().nullable(),
        reindexedChunks: z.number().nullable(),
        message: z.string(),
      },
    },
    async ({ path, snapshot }) => {
      if (ctx.indexing) await ctx.indexing;
      try {
        const result = await ctx.safeEdit.restore(path, snapshot);
        const payload = {
          ...result,
          message: `Restored ${result.path} from ${result.restoredFrom}.`,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `restore_note error: ${message}` }],
          structuredContent: {
            path,
            restoredFrom: snapshot,
            preRestoreSnapshot: null,
            reindexedChunks: null,
            message: `Error: ${message}`,
          },
          isError: true,
        };
      }
    },
  );
}
