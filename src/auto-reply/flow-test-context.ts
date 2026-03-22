import { AsyncLocalStorage } from "node:async_hooks";

export type FlowTestMode = "dry_run" | "apply";

export type CapturedFlowVaultMutation = {
  method: string;
  url: string;
  status: "captured" | "applied";
  bodyPreview?: string;
  bodyBytes?: number;
};

export type CapturedFlowMessageAction = {
  action: string;
  channel?: string;
  target?: string;
  dryRun: boolean;
  payload?: unknown;
};

export type CapturedFlowInput = {
  channel: string;
  message: string;
  sender?: string;
  senderE164?: string;
  senderName?: string;
  senderUsername?: string;
  accountId?: string;
  conversationId?: string;
  to?: string;
  sessionKey?: string;
  from?: string;
};

export type CapturedFlowPromptSnapshot = {
  inboundUserContext?: string;
  effectiveBaseBody?: string;
  prefixedBodyBase?: string;
  prefixedBody?: string;
  prefixedCommandBody?: string;
  flowContext?: string[];
  untrustedContext?: string[];
};

export type CapturedFlowModelSelection = {
  provider: string;
  model: string;
  thinkLevel?: string;
};

export type CapturedFlowToolCall = {
  name: string;
  params?: unknown;
  outcome: "success" | "error";
  result?: unknown;
  error?: string;
};

export type FlowTestCapture = {
  input?: CapturedFlowInput;
  vaultMutations: CapturedFlowVaultMutation[];
  messageActions: CapturedFlowMessageAction[];
  promptSnapshot?: CapturedFlowPromptSnapshot;
  modelSelections: CapturedFlowModelSelection[];
  systemPromptReport?: unknown;
  toolCalls: CapturedFlowToolCall[];
};

type FlowTestState = {
  mode: FlowTestMode;
  capture: FlowTestCapture;
};

const storage = new AsyncLocalStorage<FlowTestState>();

export function withFlowTestContext<T>(
  params: { mode: FlowTestMode },
  run: () => Promise<T>,
): Promise<T> {
  return storage.run(
    {
      mode: params.mode,
      capture: {
        input: undefined,
        vaultMutations: [],
        messageActions: [],
        promptSnapshot: undefined,
        modelSelections: [],
        systemPromptReport: undefined,
        toolCalls: [],
      },
    },
    run,
  );
}

export function getFlowTestContext(): FlowTestState | undefined {
  return storage.getStore();
}

export function recordFlowTestVaultMutation(entry: CapturedFlowVaultMutation): void {
  const ctx = storage.getStore();
  if (!ctx) {
    return;
  }
  ctx.capture.vaultMutations.push(entry);
}

export function recordFlowTestMessageAction(entry: CapturedFlowMessageAction): void {
  const ctx = storage.getStore();
  if (!ctx) {
    return;
  }
  ctx.capture.messageActions.push(entry);
}

export function recordFlowTestInput(entry: CapturedFlowInput): void {
  const ctx = storage.getStore();
  if (!ctx) {
    return;
  }
  ctx.capture.input = entry;
}

export function recordFlowTestPromptSnapshot(entry: CapturedFlowPromptSnapshot): void {
  const ctx = storage.getStore();
  if (!ctx) {
    return;
  }
  ctx.capture.promptSnapshot = entry;
}

export function recordFlowTestModelSelection(entry: CapturedFlowModelSelection): void {
  const ctx = storage.getStore();
  if (!ctx) {
    return;
  }
  ctx.capture.modelSelections.push(entry);
}

export function recordFlowTestSystemPromptReport(report: unknown): void {
  const ctx = storage.getStore();
  if (!ctx) {
    return;
  }
  ctx.capture.systemPromptReport = report;
}

export function recordFlowTestToolCall(entry: CapturedFlowToolCall): void {
  const ctx = storage.getStore();
  if (!ctx) {
    return;
  }
  ctx.capture.toolCalls.push(entry);
}

export function getFlowTestCaptureSnapshot(): FlowTestCapture | undefined {
  const ctx = storage.getStore();
  if (!ctx) {
    return undefined;
  }
  return {
    input: ctx.capture.input ? { ...ctx.capture.input } : undefined,
    vaultMutations: [...ctx.capture.vaultMutations],
    messageActions: [...ctx.capture.messageActions],
    promptSnapshot: ctx.capture.promptSnapshot
      ? {
          ...ctx.capture.promptSnapshot,
          flowContext: ctx.capture.promptSnapshot.flowContext
            ? [...ctx.capture.promptSnapshot.flowContext]
            : undefined,
          untrustedContext: ctx.capture.promptSnapshot.untrustedContext
            ? [...ctx.capture.promptSnapshot.untrustedContext]
            : undefined,
        }
      : undefined,
    modelSelections: [...ctx.capture.modelSelections],
    systemPromptReport: ctx.capture.systemPromptReport,
    toolCalls: [...ctx.capture.toolCalls],
  };
}
