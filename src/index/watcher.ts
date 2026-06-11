import { relative } from "node:path";

import { watch } from "chokidar";

import { logger } from "../util/logger.js";
import type { Indexer } from "./indexer.js";

const DEBOUNCE_MS = 250;

/**
 * Watches a vault and keeps the index in sync as notes are added, changed, or
 * removed. Rapid saves to a file are debounced before re-indexing.
 */
export class VaultWatcher {
  private watcher: ReturnType<typeof watch> | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Resolves once the initial scan finishes and the watcher is live. */
  ready: Promise<void> = Promise.resolve();

  constructor(
    private readonly vaultPath: string,
    private readonly indexer: Indexer,
    private readonly options: { usePolling?: boolean } = {},
  ) {}

  start(): void {
    if (this.watcher) return;
    this.watcher = watch(this.vaultPath, {
      ignoreInitial: true,
      persistent: true,
      // Native fs events are efficient but unavailable on some filesystems
      // (network drives, WSL, Docker volumes, some VMs); polling is the fallback.
      usePolling: this.options.usePolling ?? false,
      interval: 200,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: (path: string, stats?: { isFile: () => boolean }) => {
        const base = path.split(/[/\\]/).pop() ?? "";
        if (base.startsWith(".")) return true; // .obsidian, .anchor, .git, dotfiles
        if (stats?.isFile() === true && !base.toLowerCase().endsWith(".md")) return true;
        return false;
      },
    });
    this.ready = new Promise<void>((resolve) => {
      this.watcher?.on("ready", () => {
        resolve();
      });
    });
    this.watcher.on("add", (path: string) => {
      this.schedule(path);
    });
    this.watcher.on("change", (path: string) => {
      this.schedule(path);
    });
    this.watcher.on("unlink", (path: string) => {
      this.remove(path);
    });
    this.watcher.on("error", (error: unknown) => {
      logger.error("Vault watcher error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.watcher?.close();
    this.watcher = null;
  }

  private toRel(absPath: string): string {
    return relative(this.vaultPath, absPath).split(/[/\\]/).join("/");
  }

  private schedule(absPath: string): void {
    const rel = this.toRel(absPath);
    if (!rel.toLowerCase().endsWith(".md")) return;
    const existing = this.timers.get(rel);
    if (existing) clearTimeout(existing);
    this.timers.set(
      rel,
      setTimeout(() => {
        this.timers.delete(rel);
        void this.indexer
          .indexFile(rel)
          .then((written) => {
            logger.debug("Re-indexed note", { path: rel, chunks: written });
          })
          .catch((error: unknown) => {
            logger.warn("Failed to re-index a changed note", {
              path: rel,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, DEBOUNCE_MS),
    );
  }

  private remove(absPath: string): void {
    const rel = this.toRel(absPath);
    if (!rel.toLowerCase().endsWith(".md")) return;
    const pending = this.timers.get(rel);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(rel);
    }
    try {
      this.indexer.removeNote(rel);
      logger.debug("Removed note from index", { path: rel });
    } catch (error) {
      logger.warn("Failed to remove a note from the index", {
        path: rel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
