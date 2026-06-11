import { createHash } from "node:crypto";

/** Stable content hash used to skip re-indexing unchanged notes. */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
