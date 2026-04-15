import { describe, expect, it } from "vitest";
import { filterBootstrapFilesForLocalModel, type WorkspaceBootstrapFile } from "./workspace.js";

describe("filterBootstrapFilesForLocalModel", () => {
  it("keeps only the compact local bootstrap set", () => {
    const files: WorkspaceBootstrapFile[] = [
      { name: "AGENTS.md", path: "/tmp/AGENTS.md", content: "agents", missing: false },
      { name: "SOUL.md", path: "/tmp/SOUL.md", content: "soul", missing: false },
      { name: "IDENTITY.md", path: "/tmp/IDENTITY.md", content: "identity", missing: false },
      { name: "USER.md", path: "/tmp/USER.md", content: "user", missing: false },
      { name: "TOOLS.md", path: "/tmp/TOOLS.md", content: "tools", missing: false },
      { name: "HEARTBEAT.md", path: "/tmp/HEARTBEAT.md", content: "heartbeat", missing: false },
      { name: "BOOTSTRAP.md", path: "/tmp/BOOTSTRAP.md", content: "bootstrap", missing: false },
    ];

    expect(filterBootstrapFilesForLocalModel(files).map((file) => file.name)).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
    ]);
  });
});
