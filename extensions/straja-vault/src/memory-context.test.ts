import { describe, expect, it } from "vitest";
import {
  formatPersistentMemoryContext,
  isDailyMemoryPath,
  selectRecentDailyMemoryPaths,
} from "./memory-context.js";

describe("memory-context", () => {
  it("identifies daily memory paths", () => {
    expect(isDailyMemoryPath("memory/2026-03-20.md")).toBe(true);
    expect(isDailyMemoryPath("MEMORY.md")).toBe(false);
    expect(isDailyMemoryPath("memory/projects.md")).toBe(false);
  });

  it("selects the two newest daily memory files", () => {
    const selected = selectRecentDailyMemoryPaths([
      { path: "memory/2026-03-16.md" },
      { path: "memory/2026-03-19.md" },
      { path: "memory/2026-03-18.md" },
      { path: "MEMORY.md" },
    ]);

    expect(selected).toEqual(["memory/2026-03-19.md", "memory/2026-03-18.md"]);
  });

  it("formats long-term and recent daily memory into prompt context", () => {
    const context = formatPersistentMemoryContext({
      memoryContent: "# Memory\n- User: Ramona",
      recentDaily: [
        { path: "memory/2026-03-19.md", content: "Daily note A" },
        { path: "memory/2026-03-18.md", content: "Daily note B" },
      ],
    });

    expect(context).toContain("<persistent_memory>");
    expect(context).toContain("## Long-Term Memory");
    expect(context).toContain("## Recent Daily Memory");
    expect(context).toContain("### memory/2026-03-19.md");
    expect(context).toContain("Daily note B");
  });

  it("returns null when there is no usable memory content", () => {
    const context = formatPersistentMemoryContext({
      memoryContent: "   ",
      recentDaily: [],
    });

    expect(context).toBeNull();
  });
});
