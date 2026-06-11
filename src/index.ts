#!/usr/bin/env node
import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { ConfigOverrides } from "./config.js";
import { type AppContext, createContext } from "./container.js";
import { VaultWatcher } from "./index/watcher.js";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { logger } from "./util/logger.js";

let watcher: VaultWatcher | undefined;
let shuttingDown = false;

interface CliOptions {
  vaultPath: string | undefined;
  reindex: boolean;
  config: ConfigOverrides;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const positionals: string[] = [];
  const config: ConfigOverrides = {};
  let reindex = false;

  const num = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--reindex":
        reindex = true;
        break;
      case "--watch-polling":
        process.env.ANCHOR_WATCH_POLLING = "1";
        break;
      case "--verifier": {
        const value = args[(i += 1)];
        if (value) process.env.ANCHOR_VERIFIER = value;
        break;
      }
      case "--embedding": {
        const value = args[(i += 1)];
        if (value) process.env.ANCHOR_EMBEDDING = value;
        break;
      }
      case "--knn": {
        const value = num(args[(i += 1)]);
        if (value !== undefined) config.knn = value;
        break;
      }
      case "--grounded-threshold": {
        const value = num(args[(i += 1)]);
        if (value !== undefined) config.grounded = value;
        break;
      }
      case "--refuse-threshold": {
        const value = num(args[(i += 1)]);
        if (value !== undefined) config.refuse = value;
        break;
      }
      case "--evidence-min-score": {
        const value = num(args[(i += 1)]);
        if (value !== undefined) config.evidenceMinScore = value;
        break;
      }
      case "--verify-timeout-ms": {
        const value = num(args[(i += 1)]);
        if (value !== undefined) config.verifyTimeoutMs = value;
        break;
      }
      default:
        if (!arg.startsWith("-")) positionals.push(arg);
        break;
    }
  }

  return { vaultPath: positionals[0], reindex, config };
}

function installGlobalErrorHandlers(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("Unhandled promise rejection", {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });
  process.on("uncaughtException", (error: Error) => {
    logger.error("Uncaught exception", { error: error.message });
    process.exit(1);
  });
}

function installShutdownHandlers(context: AppContext | undefined): void {
  let closing = false;
  const closeDb = (): void => {
    try {
      context?.db.close();
    } catch (error) {
      logger.error("Error closing the index database", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const shutdown = (reason: string, forceExit: boolean): void => {
    if (closing) return;
    closing = true;
    shuttingDown = true;
    logger.info(`Shutting down (${reason})`);
    if (forceExit) {
      void watcher?.stop();
      closeDb();
      process.exit(0);
      return;
    }
    // stdin-close: stop the watcher, wait for any in-flight initial index to
    // settle, then close the DB and let the event loop drain so final responses
    // still flush. `shuttingDown` prevents the index pass from starting a new
    // watcher afterwards.
    void (async () => {
      await watcher?.stop();
      const indexing = context?.indexing;
      if (indexing) {
        try {
          await indexing;
        } catch {
          // already logged during indexing
        }
      }
      closeDb();
    })();
  };
  process.on("SIGINT", () => { shutdown("SIGINT", true); });
  process.on("SIGTERM", () => { shutdown("SIGTERM", true); });
  // The MCP client closing stdin (EOF) is also a shutdown signal — otherwise the
  // persistent file watcher keeps the process alive after the client exits.
  process.stdin.on("end", () => { shutdown("stdin closed", false); });
  process.stdin.on("close", () => { shutdown("stdin closed", false); });
}

async function main(): Promise<void> {
  installGlobalErrorHandlers();
  const { vaultPath, reindex, config } = parseArgs(process.argv);

  let context: AppContext | undefined;
  if (vaultPath) {
    const absVault = resolve(vaultPath);
    logger.info("Starting Anchor", { vaultPath: absVault });
    const ctx = createContext(absVault, { config, reindex });
    context = ctx;
    installShutdownHandlers(ctx);

    // Index in the BACKGROUND so a large vault never blocks the MCP initialize
    // handshake. Vault-backed tools await `context.indexing` before serving, so
    // an early call simply waits for the first index pass to finish. Once the
    // initial pass is done, watch the vault to keep the index live.
    ctx.indexing = ctx.indexer
      .indexAll()
      .then((stats) => {
        logger.info("Vault indexed", stats);
        if (shuttingDown) return;
        watcher = new VaultWatcher(absVault, ctx.indexer, {
          // Set ANCHOR_WATCH_POLLING=1 on filesystems without native fs events
          // (network drives, WSL, Docker volumes).
          usePolling: process.env.ANCHOR_WATCH_POLLING === "1",
        });
        watcher.start();
        logger.info("Watching vault for changes");
      })
      .catch((error: unknown) => {
        logger.error("Initial indexing failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  } else {
    installShutdownHandlers(undefined);
    logger.warn(
      "No vault path provided; starting in no-vault mode (only the ping tool is available). " +
        "Usage: obsidian-anchor <path-to-vault>",
    );
  }

  const server = buildServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info(`Anchor MCP server ready (${SERVER_NAME} v${SERVER_VERSION})`);
}

main().catch((error: unknown) => {
  logger.error("Fatal error during startup", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
