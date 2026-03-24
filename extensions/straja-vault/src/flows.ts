type FlowEvent = {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
};

type FlowContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  agentId?: string;
};

type VaultFileEntry = {
  path?: string;
};

type FlowDoc = {
  id: string;
  name: string;
  priority: number;
  instruction: string;
  vars: Record<string, string | number | boolean>;
  trigger: {
    channels?: string[];
    accountIds?: string[];
    senders?: string[];
    conversationIds?: string[];
  };
};

const FLOW_CACHE_TTL_MS = 10_000;

let flowCache: FlowDoc[] | null = null;
let flowCacheTs = 0;

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeKey(value: unknown): string | undefined {
  const text = normalizeText(value);
  return text ? text.toLowerCase() : undefined;
}

function normalizePhoneDigits(value: unknown): string {
  return String(value ?? "").replace(/\D+/g, "");
}

function phoneMatchVariants(value: unknown): string[] {
  const digits = normalizePhoneDigits(value);
  if (digits.length < 7) {
    return [];
  }
  const variants = new Set<string>([digits]);
  if (digits.startsWith("00") && digits.length > 9) {
    variants.add(digits.slice(2));
  }
  if (digits.startsWith("0") && digits.length > 8) {
    variants.add(digits.slice(1));
  }
  return Array.from(variants).filter((entry) => entry.length >= 7);
}

function phoneLikeMatch(left: unknown, right: unknown): boolean {
  const leftVariants = phoneMatchVariants(left);
  const rightVariants = phoneMatchVariants(right);
  if (leftVariants.length === 0 || rightVariants.length === 0) {
    return false;
  }
  for (const leftValue of leftVariants) {
    for (const rightValue of rightVariants) {
      if (leftValue === rightValue) {
        return true;
      }
      const [shorter, longer] =
        leftValue.length <= rightValue.length ? [leftValue, rightValue] : [rightValue, leftValue];
      if (shorter.length >= 7 && longer.endsWith(shorter)) {
        return true;
      }
    }
  }
  return false;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const single = normalizeKey(value);
    return single ? [single] : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const next = value
    .map((entry) => normalizeKey(entry))
    .filter((entry): entry is string => Boolean(entry));
  return next.length > 0 ? next : undefined;
}

function normalizeTemplateVars(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      out[key] = entry;
    }
  }
  return out;
}

function parseFlowDoc(path: string, raw: string): FlowDoc | null {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  if (parsed.enabled === false) {
    return null;
  }
  const kind = normalizeKey(parsed.kind) ?? "inbound_message";
  if (kind !== "inbound_message") {
    return null;
  }

  const instruction =
    normalizeText(parsed.instruction) ??
    normalizeText(parsed.instructions) ??
    normalizeText(parsed.prompt);
  if (!instruction) {
    return null;
  }

  const triggerRaw =
    parsed.trigger && typeof parsed.trigger === "object" && !Array.isArray(parsed.trigger)
      ? (parsed.trigger as Record<string, unknown>)
      : {};

  const priorityRaw = parsed.priority;
  const priority =
    typeof priorityRaw === "number" && Number.isFinite(priorityRaw) ? Math.trunc(priorityRaw) : 0;

  return {
    id: normalizeText(parsed.id) ?? path.replace(/\.json$/i, ""),
    name: normalizeText(parsed.name) ?? path,
    priority,
    instruction,
    vars: normalizeTemplateVars(parsed.vars),
    trigger: {
      channels:
        normalizeStringArray(triggerRaw.channel) ?? normalizeStringArray(triggerRaw.channels),
      accountIds:
        normalizeStringArray(triggerRaw.accountId) ?? normalizeStringArray(triggerRaw.accountIds),
      senders: normalizeStringArray(triggerRaw.sender) ?? normalizeStringArray(triggerRaw.senders),
      conversationIds:
        normalizeStringArray(triggerRaw.conversationId) ??
        normalizeStringArray(triggerRaw.conversationIds),
    },
  };
}

function buildMatchCandidates(
  event: FlowEvent,
  ctx: FlowContext,
): {
  channels: Set<string>;
  accountIds: Set<string>;
  senders: Set<string>;
  conversationIds: Set<string>;
} {
  const metadata = event.metadata ?? {};
  const senderCandidates = [
    event.from,
    metadata.senderId,
    metadata.senderE164,
    metadata.senderUsername,
    ctx.conversationId,
  ]
    .map((entry) => normalizeKey(entry))
    .filter((entry): entry is string => Boolean(entry));
  const conversationCandidates = [
    ctx.conversationId,
    metadata.originatingTo,
    metadata.to,
    event.from,
  ]
    .map((entry) => normalizeKey(entry))
    .filter((entry): entry is string => Boolean(entry));

  return {
    channels: new Set(
      [normalizeKey(ctx.channelId)].filter((entry): entry is string => Boolean(entry)),
    ),
    accountIds: new Set(
      [normalizeKey(ctx.accountId)].filter((entry): entry is string => Boolean(entry)),
    ),
    senders: new Set(senderCandidates),
    conversationIds: new Set(conversationCandidates),
  };
}

function matchesFlow(flow: FlowDoc, event: FlowEvent, ctx: FlowContext): boolean {
  const candidates = buildMatchCandidates(event, ctx);
  if (flow.trigger.channels?.length) {
    const matched = flow.trigger.channels.some((entry) => candidates.channels.has(entry));
    if (!matched) {
      return false;
    }
  }
  if (flow.trigger.accountIds?.length) {
    const matched = flow.trigger.accountIds.some((entry) => candidates.accountIds.has(entry));
    if (!matched) {
      return false;
    }
  }
  if (flow.trigger.senders?.length) {
    const matched = flow.trigger.senders.some(
      (entry) =>
        candidates.senders.has(entry) ||
        Array.from(candidates.senders).some((candidate) => phoneLikeMatch(entry, candidate)),
    );
    if (!matched) {
      return false;
    }
  }
  if (flow.trigger.conversationIds?.length) {
    const matched = flow.trigger.conversationIds.some((entry) =>
      candidates.conversationIds.has(entry),
    );
    if (!matched) {
      return false;
    }
  }
  return true;
}

function renderTemplate(template: string, vars: Record<string, string | number | boolean>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  });
}

function buildTemplateVars(flow: FlowDoc, event: FlowEvent, ctx: FlowContext) {
  const metadata = event.metadata ?? {};
  const now = new Date();
  return {
    ...flow.vars,
    flow_id: flow.id,
    flow_name: flow.name,
    from: event.from,
    content: event.content,
    channel_id: ctx.channelId,
    account_id: ctx.accountId ?? "",
    conversation_id: ctx.conversationId ?? "",
    session_key: ctx.sessionKey ?? "",
    agent_id: ctx.agentId ?? "",
    sender_id: normalizeText(metadata.senderId) ?? "",
    sender_e164: normalizeText(metadata.senderE164) ?? "",
    sender_name: normalizeText(metadata.senderName) ?? "",
    sender_username: normalizeText(metadata.senderUsername) ?? "",
    to: normalizeText(metadata.to) ?? "",
    now_iso: now.toISOString(),
    today: now.toISOString().slice(0, 10),
  };
}

function formatFlowContext(flow: FlowDoc, renderedInstruction: string): string {
  return [
    `<flow id="${flow.id}" name="${flow.name}">`,
    "This is trusted operational flow context for the current inbound message.",
    "Apply it only when the message semantically matches the flow instruction. If it does not match, ignore this flow and continue normally.",
    renderedInstruction.trim(),
    "</flow>",
  ].join("\n\n");
}

async function listFlowPaths(baseUrl: string, fetchImpl: typeof fetch): Promise<string[]> {
  const resp = await fetchImpl(`${baseUrl}/collections/_flows/files`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) {
    return [];
  }
  const files = (await resp.json()) as VaultFileEntry[];
  return files
    .map((entry) => normalizeText(entry.path))
    .filter((entry): entry is string => Boolean(entry))
    .filter((entry) => entry.toLowerCase().endsWith(".json"));
}

async function loadFlows(baseUrl: string, fetchImpl: typeof fetch): Promise<FlowDoc[]> {
  const now = Date.now();
  if (flowCache && now - flowCacheTs < FLOW_CACHE_TTL_MS) {
    return flowCache;
  }

  const paths = await listFlowPaths(baseUrl, fetchImpl);
  const docs = await Promise.all(
    paths.map(async (path) => {
      try {
        const resp = await fetchImpl(`${baseUrl}/raw/_flows/${encodeURIComponent(path)}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) {
          return null;
        }
        const raw = await resp.text();
        return parseFlowDoc(path, raw);
      } catch {
        return null;
      }
    }),
  );

  flowCache = docs
    .filter((entry): entry is FlowDoc => Boolean(entry))
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  flowCacheTs = now;
  return flowCache;
}

export async function buildInboundFlowPromptContext(params: {
  baseUrl: string;
  event: FlowEvent;
  ctx: FlowContext;
  fetchImpl?: typeof fetch;
}): Promise<string | undefined> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const flows = await loadFlows(params.baseUrl, fetchImpl);
  if (flows.length === 0) {
    return undefined;
  }
  const matched = flows.filter((flow) => matchesFlow(flow, params.event, params.ctx));
  if (matched.length === 0) {
    return undefined;
  }
  const blocks = matched
    .map((flow) => {
      const rendered = renderTemplate(
        flow.instruction,
        buildTemplateVars(flow, params.event, params.ctx),
      ).trim();
      if (!rendered) {
        return null;
      }
      return formatFlowContext(flow, rendered);
    })
    .filter((entry): entry is string => Boolean(entry));
  if (blocks.length === 0) {
    return undefined;
  }
  return blocks.join("\n\n");
}

export function resetFlowCache(): void {
  flowCache = null;
  flowCacheTs = 0;
}
