import { normalizeInboundTextNewlines } from "./inbound-text.js";

export function appendFlowContext(base: string, flowContext?: string[]): string {
  if (!Array.isArray(flowContext) || flowContext.length === 0) {
    return base;
  }
  const entries = flowContext
    .map((entry) => normalizeInboundTextNewlines(entry))
    .filter((entry) => Boolean(entry));
  if (entries.length === 0) {
    return base;
  }
  const block = ["Trusted flow context for this inbound message:", ...entries].join("\n\n");
  return [block, base].filter(Boolean).join("\n\n");
}
