import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { buildServer, SERVER_NAME, SERVER_VERSION } from "../src/server.js";

describe("anchor MCP server", () => {
  it("exposes the ping tool and responds over an in-memory transport", async () => {
    const server = buildServer();
    const client = new Client({ name: "anchor-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("ping");

    const result = await client.callTool({ name: "ping", arguments: {} });
    expect(result.structuredContent).toEqual({
      pong: true,
      server: SERVER_NAME,
      version: SERVER_VERSION,
    });

    await client.close();
    await server.close();
  });
});
