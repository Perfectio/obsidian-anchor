import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("uses sensible defaults and derives paths from the vault", () => {
    const config = resolveConfig("/vault");
    expect(config.knn).toBe(6);
    expect(config.grounded).toBe(0.8);
    expect(config.evidenceMinScore).toBe(0.35);
    expect(config.dbPath).toContain(".anchor");
  });

  it("applies overrides for tunable fields without touching the rest", () => {
    const config = resolveConfig("/vault", { knn: 10, evidenceMinScore: 0.5 });
    expect(config.knn).toBe(10);
    expect(config.evidenceMinScore).toBe(0.5);
    expect(config.grounded).toBe(0.8);
  });
});
