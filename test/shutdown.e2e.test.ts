import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Spawns the real server and verifies it exits when the client closes stdin —
// regression guard for the bug where the persistent file watcher kept the
// process alive forever. Gated (spawns a process): ANCHOR_E2E=1 npx vitest run
const RUN_E2E = process.env.ANCHOR_E2E === "1";

function send(child: ReturnType<typeof spawn>, message: object): void {
  child.stdin?.write(`${JSON.stringify(message)}\n`);
}

describe.skipIf(!RUN_E2E)("server shutdown (spawned)", () => {
  it(
    "exits cleanly when the client closes stdin",
    async () => {
      const vault = mkdtempSync(join(tmpdir(), "anchor-shutdown-")); // empty: no model download
      const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", vault], {
        stdio: ["pipe", "ignore", "ignore"],
      });

      send(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });

      // Let it boot + start the watcher, then close stdin (the shutdown signal).
      await new Promise((resolve) => setTimeout(resolve, 2000));
      child.stdin?.end();

      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(false);
        }, 8000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      rmSync(vault, { recursive: true, force: true });
      expect(exited).toBe(true);
    },
    20_000,
  );
});
