import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "./container.js";
import { registerCite } from "./tools/cite.js";
import { registerRestoreNote } from "./tools/restoreNote.js";
import { registerSafeEdit } from "./tools/safeEdit.js";
import { registerSearchNotes } from "./tools/searchNotes.js";
import { registerVerifyGrounding } from "./tools/verifyGrounding.js";
import { logger } from "./util/logger.js";

export const SERVER_NAME = "anchor";
export const SERVER_VERSION = "0.2.0";

/**
 * Builds the Anchor MCP server with its tools registered.
 *
 * The server is transport-agnostic: callers attach a transport (stdio in
 * production, in-memory in tests) via `server.connect(...)`. Vault-backed tools
 * are registered only when an {@link AppContext} is supplied.
 */
export function buildServer(context?: AppContext): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerPingTool(server);
  if (context) {
    registerSearchNotes(server, context);
    registerVerifyGrounding(server, context);
    registerCite(server, context);
    registerSafeEdit(server, context);
    registerRestoreNote(server, context);
  }

  return server;
}

/**
 * A trivial health-check tool. It exists so the server boot, tool registration,
 * and transport handshake can be validated end-to-end before any real tooling
 * (search / grounding) lands.
 */
function registerPingTool(server: McpServer): void {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Health check. Returns pong plus the server name and version.",
      inputSchema: {},
      outputSchema: {
        pong: z.literal(true),
        server: z.string(),
        version: z.string(),
      },
    },
    () => {
      logger.debug("ping invoked");
      const payload = {
        pong: true as const,
        server: SERVER_NAME,
        version: SERVER_VERSION,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  );
}
