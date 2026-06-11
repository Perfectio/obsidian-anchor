import { describe, expect, it } from "vitest";

import { chunkNote } from "../src/chunk/chunker.js";

const FIXTURE = [
  "---",
  "title: Auth",
  "---",
  "# Auth",
  "",
  "Some intro paragraph.",
  "",
  "## Decisions",
  "",
  "We chose Postgres for the primary store. ^k93a",
  "",
  "See [[Projects/Infra|infra notes]] for details.",
  "",
  "## Timeline",
  "",
  "```",
  "# not a heading inside code",
  'print("hi")',
  "```",
  "",
  "- item one",
  "- item two",
  "",
].join("\n");

describe("chunkNote", () => {
  const chunks = chunkNote("Projects/Auth.md", FIXTURE);

  it("emits one chunk per content block (headings excluded)", () => {
    expect(chunks).toHaveLength(5);
  });

  it("captures the heading breadcrumb", () => {
    expect(chunks[0]?.meta.headingPath).toBe("Auth");
    expect(chunks[0]?.meta.anchor).toBe("#Auth");
    expect(chunks[1]?.meta.headingPath).toBe("Auth > Decisions");
  });

  it("captures an explicit ^block-id and resolves its anchor", () => {
    expect(chunks[1]?.meta.blockId).toBe("k93a");
    expect(chunks[1]?.meta.anchor).toBe("#^k93a");
  });

  it("extracts wikilinks with alias", () => {
    expect(chunks[2]?.meta.wikilinks).toEqual([
      { targetNote: "Projects/Infra", targetAnchor: null, alias: "infra notes" },
    ]);
  });

  it("does not treat a '#' inside a code fence as a heading", () => {
    const code = chunks[3];
    expect(code?.text).toContain("# not a heading inside code");
    // The list after the code block still sits under Timeline, proving the
    // fenced '#' never pushed a heading frame.
    expect(chunks[4]?.meta.headingPath).toBe("Auth > Timeline");
  });

  it("keeps char offsets exact (slice equals chunk text)", () => {
    for (const chunk of chunks) {
      expect(FIXTURE.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it("splits an oversized block to fit the embedding limit, preserving offsets", () => {
    const big = "word ".repeat(500).trim(); // ~2.5k chars, single block
    const md = `# H\n\n${big}\n`;
    const split = chunkNote("Big.md", md);
    expect(split.length).toBeGreaterThan(1);
    for (const chunk of split) {
      expect(chunk.text.length).toBeLessThanOrEqual(1000);
      expect(md.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it("indexes frontmatter aliases/tags as a chunk (offset-exact)", () => {
    const md = "---\ntitle: Auth\naliases: [authentication, login]\ntags: [project]\n---\n# Auth\n\nBody.\n";
    const chunks = chunkNote("Auth.md", md);
    const fm = chunks.find((chunk) => chunk.text.includes("authentication"));
    expect(fm).toBeDefined();
    expect(fm?.text).toContain("tags");
    for (const chunk of chunks) {
      expect(md.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it("does not index frontmatter without aliases/tags", () => {
    const md = "---\ntitle: Auth\n---\n# Auth\n\nBody.\n";
    const chunks = chunkNote("Auth.md", md);
    expect(chunks.some((chunk) => chunk.text.includes("title: Auth"))).toBe(false);
  });

  it("splits a markdown table into one chunk per row, dropping the separator", () => {
    const md = "# T\n\n| Plan | Price |\n| --- | --- |\n| Free | $0 |\n| Pro | $20 |\n";
    const rows = chunkNote("T.md", md).map((chunk) => chunk.text);
    expect(rows).toContain("| Pro | $20 |");
    expect(rows).toContain("| Free | $0 |");
    expect(rows.some((text) => text.includes("---"))).toBe(false); // separator dropped
    for (const chunk of chunkNote("T.md", md)) {
      expect(md.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });
});
