import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createContext } from "../src/container.js";
import type { EmbeddingProvider } from "../src/embeddings/provider.js";
import type { ApplyResult, DryRunResult } from "../src/edit/safeEdit.js";

// Trivial fixed embedder — safe_edit tests don't exercise search quality.
class FixedEmbeddings implements EmbeddingProvider {
  readonly id = "fixed";
  readonly dim = 4;
  embed(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map(() => Float32Array.from([1, 0, 0, 0])));
  }
  embedOne(): Promise<Float32Array> {
    return Promise.resolve(Float32Array.from([1, 0, 0, 0]));
  }
}

describe("SafeEditService", () => {
  const vault = mkdtempSync(join(tmpdir(), "anchor-edit-"));
  mkdirSync(join(vault, "Projects"), { recursive: true });
  const ctx = createContext(vault, { embeddings: new FixedEmbeddings() });

  afterAll(() => {
    ctx.db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  function writeNote(rel: string, content: string): string {
    const abs = join(vault, rel);
    writeFileSync(abs, content);
    return abs;
  }

  it("returns a dry-run diff + token without modifying the file", async () => {
    const abs = writeNote("Projects/A.md", "# A\n\nWe use MySQL.\n");
    const result = (await ctx.safeEdit.edit(
      "Projects/A.md",
      "We use MySQL.",
      "We use Postgres.",
    )) as DryRunResult;

    expect(result.mode).toBe("dry-run");
    expect(result.diff).toContain("-We use MySQL.");
    expect(result.diff).toContain("+We use Postgres.");
    expect(result.token).toMatch(/^[0-9a-f]{16}$/);
    expect(readFileSync(abs, "utf8")).toContain("MySQL"); // unchanged
  });

  it("applies with a valid token, saves a rollback snapshot, and re-indexes", async () => {
    const abs = writeNote("Projects/B.md", "# B\n\nWe use MySQL.\n");
    const dry = (await ctx.safeEdit.edit(
      "Projects/B.md",
      "We use MySQL.",
      "We use Postgres.",
    )) as DryRunResult;

    const applied = (await ctx.safeEdit.edit(
      "Projects/B.md",
      "We use MySQL.",
      "We use Postgres.",
      dry.token,
    )) as ApplyResult;

    expect(applied.mode).toBe("applied");
    expect(readFileSync(abs, "utf8")).toContain("Postgres");
    expect(existsSync(join(vault, applied.snapshot))).toBe(true);
    expect(readFileSync(join(vault, applied.snapshot), "utf8")).toContain("MySQL"); // rollback copy
  });

  it("rejects a stale or wrong confirmation token", async () => {
    writeNote("Projects/C.md", "# C\n\nWe use MySQL.\n");
    await expect(
      ctx.safeEdit.edit("Projects/C.md", "We use MySQL.", "We use Redis.", "deadbeefdeadbeef"),
    ).rejects.toThrow(/token/i);
  });

  it("refuses to edit a path outside the vault", async () => {
    await expect(ctx.safeEdit.edit("../escape.md", "a", "b")).rejects.toThrow(/outside the vault/i);
  });

  it("rejects when the target text is not found", async () => {
    writeNote("Projects/D.md", "# D\n\nWe use MySQL.\n");
    await expect(
      ctx.safeEdit.edit("Projects/D.md", "this text is absent", "x"),
    ).rejects.toThrow(/not found/i);
  });

  it("restores a note from a snapshot (and the restore is undoable)", async () => {
    const abs = writeNote("Projects/R.md", "# R\n\noriginal content here\n");
    const dry = (await ctx.safeEdit.edit("Projects/R.md", "original content here", "new content")) as DryRunResult;
    const applied = (await ctx.safeEdit.edit(
      "Projects/R.md",
      "original content here",
      "new content",
      dry.token,
    )) as ApplyResult;
    expect(readFileSync(abs, "utf8")).toContain("new content");

    const restored = await ctx.safeEdit.restore("Projects/R.md", applied.snapshot);
    expect(restored.restoredFrom).toBe(applied.snapshot);
    expect(readFileSync(abs, "utf8")).toContain("original content here");
    expect(restored.preRestoreSnapshot).toBeTruthy();
  });

  it("rejects a snapshot path outside .anchor/snapshots", async () => {
    await expect(ctx.safeEdit.restore("Projects/R.md", "../evil.bak")).rejects.toThrow(
      /inside \.anchor/i,
    );
  });
});
