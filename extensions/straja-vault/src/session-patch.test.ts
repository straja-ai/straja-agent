import { describe, expect, it } from "vitest";
import { isTransientSessionWriteError } from "./session-patch.js";

describe("session-patch transient write detection", () => {
  it("treats vault busy and timeout failures as transient", () => {
    expect(isTransientSessionWriteError(new Error("spawnSync curl ETIMEDOUT"))).toBe(true);
    expect(isTransientSessionWriteError(new Error("Vault HTTP POST failed: HTTP 503"))).toBe(true);
    expect(isTransientSessionWriteError(new Error("SqliteError: database is locked"))).toBe(true);
    expect(isTransientSessionWriteError(new Error("Error: aborted"))).toBe(true);
  });

  it("keeps auth and validation failures fatal", () => {
    expect(isTransientSessionWriteError(new Error("Vault HTTP POST failed: HTTP 401"))).toBe(false);
    expect(isTransientSessionWriteError(new Error("Vault HTTP POST failed: HTTP 403"))).toBe(false);
    expect(isTransientSessionWriteError(new Error("Vault HTTP POST failed: HTTP 404"))).toBe(false);
  });
});
