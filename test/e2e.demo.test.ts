import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createContext } from "../src/container.js";

// The killer demo, guarded so it can never silently regress. Uses the REAL local
// embedding + NLI models, so it is opt-in (downloads models on first run):
//   ANCHOR_E2E=1 npx vitest run
const RUN_E2E = process.env.ANCHOR_E2E === "1";

describe.skipIf(!RUN_E2E)("end-to-end grounding demo (real models)", () => {
  const vault = mkdtempSync(join(tmpdir(), "anchor-e2e-"));
  mkdirSync(join(vault, "Projects"), { recursive: true });
  writeFileSync(
    join(vault, "Projects", "Auth.md"),
    [
      "# Auth Rewrite",
      "",
      "## Timeline",
      "",
      "The auth rewrite slipped to Q3 2026. March only covered the design phase — no code shipped in March. ^k93a",
      "",
      "## Decisions",
      "",
      "Decision: use Postgres as the primary data store, chosen over MySQL for its JSONB support. ^d4e1",
      "",
    ].join("\n"),
  );

  const ctx = createContext(vault);

  afterAll(() => {
    ctx.db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it(
    "grounds a truthful claim and refuses an invented one — each with the right citation",
    async () => {
      await ctx.indexer.indexAll();

      const truthful = await ctx.grounding.verify("We chose Postgres as our primary data store.");
      expect(truthful.verdict).toBe("grounded");
      expect(truthful.perClaim[0]?.verdict).toBe("supported");
      expect(truthful.perClaim[0]?.evidence[0]?.anchor).toBe("#^d4e1");

      const invented = await ctx.grounding.verify("The auth rewrite shipped in March.");
      expect(invented.verdict).toBe("refused");
      expect(invented.grounded).toBe(false);
      expect(invented.perClaim[0]?.verdict).toBe("contradicted");
      expect(invented.perClaim[0]?.evidence[0]?.anchor).toBe("#^k93a");
    },
    120_000,
  );
});
