import { readdir } from "node:fs/promises";
import { join } from "node:path";

// System/hidden directories that never contain user notes.
const SKIP_DIRS = new Set([".obsidian", ".trash", ".anchor", ".git", "node_modules"]);

/**
 * Lists markdown files in a vault as vault-relative POSIX paths, skipping
 * Obsidian/system directories and anything dot-prefixed.
 */
export async function walkVault(vaultPath: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        await walk(join(absDir, entry.name), relPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push(relPath);
      }
    }
  }

  await walk(vaultPath, "");
  return out;
}
