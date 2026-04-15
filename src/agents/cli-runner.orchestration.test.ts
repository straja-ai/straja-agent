import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCliAgent } from "./cli-runner.js";

const supervisorSpawnMock = vi.fn();
const persistOrchestrationPromptInputMock = vi.fn();
const persistOrchestrationPromptOutputMock = vi.fn();
const persistOrchestrationStepMock = vi.fn();

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: (...args: unknown[]) => supervisorSpawnMock(...args),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

vi.mock("./bootstrap-files.js", () => ({
  makeBootstrapWarn: () => () => undefined,
  resolveBootstrapContextForRun: vi.fn().mockResolvedValue({ contextFiles: [] }),
}));

vi.mock("./docs-path.js", () => ({
  resolveOpenClawDocsPath: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../auto-reply/reply/orchestration-vault.js", () => ({
  persistOrchestrationPromptInput: (...args: unknown[]) =>
    persistOrchestrationPromptInputMock(...args),
  persistOrchestrationPromptOutput: (...args: unknown[]) =>
    persistOrchestrationPromptOutputMock(...args),
  persistOrchestrationStep: (...args: unknown[]) => persistOrchestrationStepMock(...args),
}));

function createManagedRun() {
  return {
    runId: "run-supervisor",
    pid: 1234,
    startedAtMs: Date.now(),
    stdin: undefined,
    wait: vi.fn().mockResolvedValue({
      reason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 50,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    }),
    cancel: vi.fn(),
  };
}

describe("runCliAgent orchestration tracing", () => {
  beforeEach(() => {
    supervisorSpawnMock.mockReset();
    persistOrchestrationPromptInputMock.mockReset();
    persistOrchestrationPromptOutputMock.mockReset();
    persistOrchestrationStepMock.mockReset();
    persistOrchestrationPromptInputMock.mockResolvedValue(undefined);
    persistOrchestrationPromptOutputMock.mockResolvedValue(undefined);
    persistOrchestrationStepMock.mockResolvedValue(undefined);
  });

  it("persists prompt input/output for traced CLI runs", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(createManagedRun());

    await runCliAgent({
      sessionId: "s-trace",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "trace me",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-trace",
      orchestrationTraceId: "trace-123",
      cliSessionId: "thread-123",
    });

    expect(persistOrchestrationPromptInputMock).toHaveBeenCalledTimes(1);
    expect(persistOrchestrationPromptInputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-123",
        runId: "run-trace",
        sessionId: "s-trace",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        prompt: "trace me",
      }),
    );
    expect(persistOrchestrationPromptOutputMock).toHaveBeenCalledTimes(1);
    expect(persistOrchestrationPromptOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-123",
        runId: "run-trace",
        sessionId: "s-trace",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        assistantTexts: ["ok"],
      }),
    );
    expect(persistOrchestrationStepMock).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-123",
        stage: "llm_input",
      }),
    );
    expect(persistOrchestrationStepMock).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-123",
        stage: "llm_output",
      }),
    );
  });
});
