import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { Indexer } from "../index/indexer.js";
import { sha256 } from "../util/hash.js";
import { writeSnapshot } from "./snapshots.js";

export interface DryRunResult {
  mode: "dry-run";
  path: string;
  /** Unified-diff-style preview of the proposed change. */
  diff: string;
  /** Opaque token that pins this exact change against the current file state. */
  token: string;
}

export interface ApplyResult {
  mode: "applied";
  path: string;
  /** Vault-relative path of the rollback snapshot. */
  snapshot: string;
  /** Chunks re-indexed after the edit (null if the note was skipped). */
  reindexedChunks: number | null;
}

export type EditResult = DryRunResult | ApplyResult;

export interface RestoreResult {
  path: string;
  restoredFrom: string;
  /** Snapshot of the pre-restore content (so the restore is itself undoable). */
  preRestoreSnapshot: string | null;
  reindexedChunks: number | null;
}

/**
 * Safe note edits: a string replacement is first returned as a dry-run diff +
 * token; calling again with that token applies it, saving a rollback snapshot
 * and re-indexing the note. The token also guards against the file changing
 * between preview and apply.
 */
export class SafeEditService {
  constructor(
    private readonly vaultPath: string,
    private readonly indexer: Indexer,
  ) {}

  async edit(
    relPath: string,
    oldText: string,
    newText: string,
    confirm?: string,
  ): Promise<EditResult> {
    const abs = this.resolveWithinVault(relPath);

    let current: string;
    try {
      current = await readFile(abs, "utf8");
    } catch {
      throw new Error(`Note not found or unreadable: ${relPath}`);
    }

    const next = applyReplacement(current, oldText, newText);
    if (next === current) {
      throw new Error("The replacement produces no change.");
    }

    const token = computeToken(relPath, current, next);
    if (confirm === undefined) {
      return { mode: "dry-run", path: relPath, diff: makeDiff(current, next), token };
    }
    if (confirm !== token) {
      throw new Error(
        "Confirmation token does not match; the note may have changed. Re-run the dry run and confirm with the new token.",
      );
    }

    const snapshot = await writeSnapshot(this.vaultPath, relPath, current, Date.now());
    await writeFile(abs, next, "utf8");
    const reindexedChunks = await this.indexer.indexFile(relPath);
    return { mode: "applied", path: relPath, snapshot, reindexedChunks };
  }

  /** Restores a note from a snapshot, saving a pre-restore snapshot first. */
  async restore(relPath: string, snapshotRelPath: string): Promise<RestoreResult> {
    const abs = this.resolveWithinVault(relPath);
    const snapshotAbs = this.resolveSnapshot(snapshotRelPath);

    let snapshotContent: string;
    try {
      snapshotContent = await readFile(snapshotAbs, "utf8");
    } catch {
      throw new Error(`Snapshot not found: ${snapshotRelPath}`);
    }

    // Save the current content first so the restore is itself undoable.
    let preRestoreSnapshot: string | null = null;
    try {
      const current = await readFile(abs, "utf8");
      preRestoreSnapshot = await writeSnapshot(this.vaultPath, relPath, current, Date.now());
    } catch {
      // The note may not currently exist (restoring a deleted note); that's fine.
    }

    await writeFile(abs, snapshotContent, "utf8");
    const reindexedChunks = await this.indexer.indexFile(relPath);
    return { path: relPath, restoredFrom: snapshotRelPath, preRestoreSnapshot, reindexedChunks };
  }

  private resolveWithinVault(relPath: string): string {
    const root = resolve(this.vaultPath);
    const abs = resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error("Refusing to edit a path outside the vault.");
    }
    if (!abs.toLowerCase().endsWith(".md")) {
      throw new Error("safe_edit only edits Markdown (.md) notes.");
    }
    return abs;
  }

  private resolveSnapshot(snapshotRelPath: string): string {
    const root = resolve(this.vaultPath);
    const snapshotsDir = resolve(root, ".anchor", "snapshots");
    const abs = resolve(root, snapshotRelPath);
    if (abs !== snapshotsDir && !abs.startsWith(snapshotsDir + sep)) {
      throw new Error("Snapshot path must be inside .anchor/snapshots.");
    }
    return abs;
  }
}

/** Replaces the single occurrence of `oldText`; rejects 0 or multiple matches. */
function applyReplacement(current: string, oldText: string, newText: string): string {
  const first = current.indexOf(oldText);
  if (first === -1) {
    throw new Error("The text to replace was not found in the note.");
  }
  if (current.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error(
      "The text to replace appears multiple times; include more surrounding context to make it unique.",
    );
  }
  return current.slice(0, first) + newText + current.slice(first + oldText.length);
}

function computeToken(relPath: string, current: string, next: string): string {
  return sha256(`${relPath}\n${current}\n${next}`).slice(0, 16);
}

/** Produces a compact single-hunk unified diff for one contiguous change. */
function makeDiff(oldContent: string, newContent: string, context = 3): string {
  const a = oldContent.split("\n");
  const b = newContent.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }

  const ctxStart = Math.max(0, start - context);
  const ctxEndA = Math.min(a.length - 1, endA + context);
  const lines: string[] = [
    `@@ -${String(start + 1)},${String(endA - start + 1)} +${String(start + 1)},${String(endB - start + 1)} @@`,
  ];
  for (let i = ctxStart; i < start; i += 1) lines.push(` ${a[i] ?? ""}`);
  for (let i = start; i <= endA; i += 1) lines.push(`-${a[i] ?? ""}`);
  for (let i = start; i <= endB; i += 1) lines.push(`+${b[i] ?? ""}`);
  for (let i = endA + 1; i <= ctxEndA; i += 1) lines.push(` ${a[i] ?? ""}`);
  return lines.join("\n");
}
