import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SNAPSHOT_DIR = join(".anchor", "snapshots");
const MAX_SNAPSHOTS_PER_NOTE = 20;

/**
 * Saves a pre-edit copy of a note so an edit can be rolled back. Returns the
 * vault-relative path of the snapshot, and prunes old snapshots for the note.
 */
export async function writeSnapshot(
  vaultPath: string,
  relPath: string,
  content: string,
  timestamp: number,
): Promise<string> {
  const dir = join(vaultPath, SNAPSHOT_DIR);
  await mkdir(dir, { recursive: true });
  const encoded = relPath.replace(/[\\/]/g, "__");
  const safeName = `${String(timestamp)}-${encoded}.bak`;
  await writeFile(join(dir, safeName), content, "utf8");
  await prune(dir, encoded);
  return join(SNAPSHOT_DIR, safeName);
}

/** Keeps only the most recent MAX_SNAPSHOTS_PER_NOTE snapshots for a note. */
async function prune(dir: string, encoded: string): Promise<void> {
  const suffix = `-${encoded}.bak`;
  const entries = (await readdir(dir)).filter((name) => name.endsWith(suffix));
  if (entries.length <= MAX_SNAPSHOTS_PER_NOTE) return;
  // Filenames are `<timestamp>-<encoded>.bak`; the timestamp is the digits before
  // the first dash. Sort newest-first and delete the overflow.
  entries.sort((a, b) => Number(b.split("-")[0] ?? 0) - Number(a.split("-")[0] ?? 0));
  for (const old of entries.slice(MAX_SNAPSHOTS_PER_NOTE)) {
    await unlink(join(dir, old)).catch(() => undefined);
  }
}
