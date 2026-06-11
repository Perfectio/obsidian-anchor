import { expect, it, vi } from "vitest";

import { logger } from "../src/util/logger.js";

// Protocol safety: stdout is the MCP stdio transport, so Anchor's logger must
// only ever write to stderr. This locks that invariant (the no-console lint rule
// covers accidental console.* use; this covers the logger itself).
it("writes logs to stderr, never stdout (MCP stdio safety)", () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  logger.error("boom", { detail: 1 });

  expect(stderr).toHaveBeenCalled();
  expect(stdout).not.toHaveBeenCalled();

  stdout.mockRestore();
  stderr.mockRestore();
});
