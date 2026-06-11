import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { walkVault } from "../src/index/walk.js";

describe("walkVault", () => {
  const vault = mkdtempSync(join(tmpdir(), "anchor-walk-"));

  beforeAll(() => {
    mkdirSync(join(vault, "sub"), { recursive: true });
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    writeFileSync(join(vault, "a.md"), "x");
    writeFileSync(join(vault, "sub", "b.md"), "x");
    writeFileSync(join(vault, "notes.txt"), "x"); // non-md
    writeFileSync(join(vault, ".obsidian", "c.md"), "x"); // inside a system dir
  });

  afterAll(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("lists markdown files as POSIX paths, skipping non-md files and system dirs", async () => {
    const files = (await walkVault(vault)).sort();
    expect(files).toEqual(["a.md", "sub/b.md"]);
  });
});
