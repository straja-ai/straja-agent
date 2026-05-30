/**
 * End-to-end validation suite for the Straja inbound-flow pipeline (Approach A:
 * LLM-prompt prepend). Four suites:
 *
 *   1. Environment probe (vault + agent + auth + hooks token)
 *   2. Flow loading + prepend rendering (pure-code, no LLM)
 *   3. Live /hooks/agent end-to-end (POST + tail agent-gateway.log)
 *   4. Idempotency / repeat-safety smoke test
 *
 * Run:
 *   pnpm tsx scripts/validate-e2e.ts
 *
 * Exit codes: 0 = all PASS, 1 = at least one FAIL.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildInboundFlowPromptContext,
  resetFlowCache,
} from "../extensions/straja-vault/src/flows.js";

// ---------- ANSI ----------
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

function tag(status: SuiteStatus): string {
  if (status === "pass") {
    return `${GREEN}${BOLD}PASS${RESET}`;
  }
  if (status === "fail") {
    return `${RED}${BOLD}FAIL${RESET}`;
  }
  return `${YELLOW}${BOLD}WARN${RESET}`;
}

// ---------- Types ----------
type SuiteStatus = "pass" | "fail" | "warn";
interface SuiteResult {
  name: string;
  status: SuiteStatus;
  details: string[];
  nextStep?: string;
}

// ---------- Constants ----------
const VAULT_URL = "http://localhost:8181";
const AGENT_URL = "http://127.0.0.1:18790";
const TARGET_FROM = "validator@test.example";
const TARGET_SUBJECT = "cancellation";
const TARGET_BODY = `Subject: ${TARGET_SUBJECT}\n\nPlease cancel my registration. -- Validator`;
const AGENT_LOG_PATH = path.join(
  homedir(),
  "Library/Application Support/StrajaWorkspaceAlpha/logs/agent-gateway.log",
);
const OPENCLAW_JSON_PATH = path.join(
  homedir(),
  "Library/Application Support/StrajaWorkspaceAlpha/agent/openclaw.json",
);

// ---------- Helpers ----------
function maskToken(t: string): string {
  if (t.length <= 8) {
    return "***";
  }
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

function trunc(s: string, n: number): string {
  if (s.length <= n) {
    return s;
  }
  return `${s.slice(0, n)}…(+${s.length - n})`;
}

async function readHooksToken(): Promise<string> {
  const raw = await readFile(OPENCLAW_JSON_PATH, "utf-8");
  const parsed = JSON.parse(raw) as { hooks?: { token?: string } };
  const token = parsed.hooks?.token;
  if (!token) {
    throw new Error(`hooks.token not found in ${OPENCLAW_JSON_PATH}`);
  }
  return token;
}

async function tailLogAfter(startMs: number, untilMs: number): Promise<string[]> {
  const buf = await readFile(AGENT_LOG_PATH, "utf-8").catch(() => "");
  const lines = buf.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
    if (!m) {
      continue;
    }
    const ts = Date.parse(m[1]);
    if (Number.isFinite(ts) && ts >= startMs - 500 && ts <= untilMs + 500) {
      out.push(line);
    }
  }
  return out;
}

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 750,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) {
      return v;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return undefined;
}

// ---------- Suite 1: Environment ----------
async function suite1(): Promise<SuiteResult & { token?: string }> {
  const details: string[] = [];
  let status: SuiteStatus = "pass";
  let token: string | undefined;

  try {
    token = await readHooksToken();
    details.push(`hooks token loaded: ${maskToken(token)}`);
  } catch (err) {
    details.push(`ERROR loading hooks token: ${(err as Error).message}`);
    return {
      name: "Environment & versions",
      status: "fail",
      details,
      nextStep: "Ensure Straja is installed and openclaw.json exists.",
    };
  }

  // Vault status
  try {
    const r = await fetch(`${VAULT_URL}/status`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) {
      status = "fail";
      details.push(`vault /status returned ${r.status}`);
    } else {
      const body = (await r.json()) as {
        collections: { name: string }[];
        totalDocuments: number;
      };
      const names = body.collections.map((c) => c.name);
      details.push(
        `vault reachable at ${VAULT_URL} (${body.totalDocuments} docs, ${names.length} collections)`,
      );
      details.push(`  collections: ${names.slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""}`);
    }
  } catch (err) {
    status = "fail";
    details.push(`vault unreachable: ${(err as Error).message}`);
  }

  // Agent reachability + auth wiring
  try {
    const r1 = await fetch(`${AGENT_URL}/hooks/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    const r2 = await fetch(`${AGENT_URL}/hooks/agent`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (r1.status !== 401) {
      status = status === "pass" ? "warn" : status;
      details.push(`/hooks/agent without token returned ${r1.status} (expected 401)`);
    } else {
      details.push("agent /hooks/agent without token → 401 (auth wiring OK)");
    }
    if (r2.status !== 401 && r2.status !== 405) {
      status = status === "pass" ? "warn" : status;
      details.push(`/hooks/agent GET with token returned ${r2.status} (expected 401/405)`);
    } else {
      details.push(`agent /hooks/agent endpoint exists (GET with token → ${r2.status})`);
    }
    details.push(`auth scheme: Authorization: Bearer <token>`);
  } catch (err) {
    status = "fail";
    details.push(`agent unreachable: ${(err as Error).message}`);
  }

  return {
    name: "Environment & versions",
    status,
    details,
    token,
    nextStep:
      status === "fail" ? "Start Straja (vault on 8181, agent on 18790) and re-run." : undefined,
  };
}

// ---------- Suite 2: Flow loading + prepend rendering ----------
async function suite2(): Promise<SuiteResult> {
  const details: string[] = [];
  resetFlowCache();
  try {
    const prepend = await buildInboundFlowPromptContext({
      baseUrl: VAULT_URL,
      event: {
        from: TARGET_FROM,
        content: TARGET_BODY,
        timestamp: Date.now(),
        metadata: {
          subject: TARGET_SUBJECT,
          senderId: TARGET_FROM,
          senderName: "Validator",
        },
      },
      ctx: {
        channelId: "email",
        sessionKey: "validator-suite",
      },
    });

    if (!prepend) {
      return {
        name: "Flow loading + prepend rendering",
        status: "fail",
        details: [
          "buildInboundFlowPromptContext returned undefined",
          "No flow in _flows/ matched (channel=email, from=validator@test.example).",
        ],
        nextStep:
          "Verify a flow exists in _flows/ with trigger.channels including 'email' and no sender restriction (or one that matches the test envelope).",
      };
    }

    const flowMatches = Array.from(prepend.matchAll(/<flow id="([^"]+)" name="([^"]+)">/g));
    details.push(`prepend length: ${prepend.length} chars`);
    details.push(`flow blocks rendered: ${flowMatches.length}`);
    for (const m of flowMatches.slice(0, 5)) {
      details.push(`  - id=${m[1]} name="${m[2]}"`);
    }
    // Confirm template substitution actually fired — message/from should appear.
    const subbed = prepend.includes(TARGET_FROM) || prepend.includes("Validator");
    if (!subbed) {
      details.push(
        `${YELLOW}warning: prepend does not include the test sender — flow instructions may not use {{from}} / {{sender_name}}.${RESET}`,
      );
    }
    return {
      name: "Flow loading + prepend rendering",
      status: "pass",
      details,
    };
  } catch (err) {
    return {
      name: "Flow loading + prepend rendering",
      status: "fail",
      details: [`exception: ${(err as Error).message}`],
      nextStep:
        "Check that the vault is reachable and that _flows/*.json parses as valid flow docs.",
    };
  }
}

// ---------- Suite 3: Live /hooks/agent E2E ----------
async function suite3(token: string | undefined): Promise<SuiteResult> {
  const details: string[] = [];
  if (!token) {
    return {
      name: "Live /hooks/agent E2E",
      status: "fail",
      details: ["no hooks token from suite 1"],
    };
  }

  const ts = Date.now();
  const envelope = {
    name: `e2e-validator-${ts}`,
    message: "e2e validator",
    agentId: "straja-chief-of-staff",
    wakeMode: "next-heartbeat",
    deliver: false,
    channel: "last",
    inbound: {
      channel: "email",
      from: TARGET_FROM,
      content: TARGET_BODY,
      metadata: {
        subject: TARGET_SUBJECT,
        senderName: "Validator",
        senderId: TARGET_FROM,
      },
    },
  };

  const postStart = Date.now();
  let runId = "?";
  try {
    const r = await fetch(`${AGENT_URL}/hooks/agent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status !== 202 && r.status !== 200) {
      const txt = await r.text();
      return {
        name: "Live /hooks/agent E2E",
        status: "fail",
        details: [...details, `POST returned ${r.status}: ${trunc(txt, 200)}`],
      };
    }
    const body = (await r.json()) as { ok?: boolean; runId?: string };
    runId = body.runId ?? "?";
    details.push(`POST /hooks/agent → ${r.status} runId=${runId}`);
  } catch (err) {
    return {
      name: "Live /hooks/agent E2E",
      status: "fail",
      details: [...details, `POST exception: ${(err as Error).message}`],
    };
  }

  // Tail log for up to 90s. The terminal signals we want:
  //   - "prepended N chars of inbound flow context" → flow matched, prepend applied
  //   - "no inbound flow context (no plugin returned prepend)" → matcher returned 0
  const observed = await waitFor(
    async () => {
      const lines = await tailLogAfter(postStart, Date.now());
      const text = lines.join("\n");
      if (
        /prepended \d+ chars of inbound flow context/.test(text) ||
        /no inbound flow context/.test(text)
      ) {
        return lines;
      }
      return undefined;
    },
    90_000,
    1000,
  );

  const finalLines = observed ?? (await tailLogAfter(postStart, Date.now()));
  const ourLines = finalLines.filter((l) =>
    /hook .*e2e-validator|inbound dispatcher entered|prepended \d+ chars of inbound flow context|no inbound flow context/.test(
      l,
    ),
  );
  details.push("captured log lines:");
  for (const l of ourLines.slice(-20)) {
    details.push(`  ${DIM}${trunc(l, 240)}${RESET}`);
  }

  const text = finalLines.join("\n");
  const sawDispatcher = /inbound dispatcher entered/.test(text);
  const sawPrepended = /prepended \d+ chars of inbound flow context/.test(text);
  const sawNoContext = /no inbound flow context/.test(text);

  details.push(
    `observed: dispatcher=${sawDispatcher} prepended=${sawPrepended} noContext=${sawNoContext}`,
  );

  let status: SuiteStatus;
  let nextStep: string | undefined;
  if (sawPrepended) {
    status = "pass";
  } else if (sawNoContext) {
    status = "fail";
    nextStep =
      "Plugin matched 0 flows for the inbound envelope. Verify the flow trigger config vs envelope channel/from.";
  } else if (!sawDispatcher) {
    status = "fail";
    nextStep =
      "Hook accepted but the inbound dispatcher never logged. Likely a stale bundle — quit and relaunch Straja.";
  } else {
    status = "fail";
    nextStep = "Unexpected log shape — review the captured lines above.";
  }

  return { name: "Live /hooks/agent E2E", status, details, nextStep };
}

// ---------- Suite 4: Idempotency ----------
async function suite4(token: string | undefined): Promise<SuiteResult> {
  const details: string[] = [];
  if (!token) {
    return { name: "Idempotency", status: "fail", details: ["no hooks token"] };
  }
  const baseEnvelope = {
    message: "idempotency",
    agentId: "straja-chief-of-staff",
    wakeMode: "next-heartbeat",
    deliver: false,
    channel: "last",
    inbound: {
      channel: "email",
      from: TARGET_FROM,
      content: TARGET_BODY,
      metadata: {
        subject: TARGET_SUBJECT,
        senderName: "Validator",
        senderId: TARGET_FROM,
      },
    },
  };

  const statuses: number[] = [];
  const runIds: string[] = [];

  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(`${AGENT_URL}/hooks/agent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ...baseEnvelope, name: `idemp-${Date.now()}-${i}` }),
        signal: AbortSignal.timeout(10_000),
      });
      statuses.push(r.status);
      const body = (await r.json().catch(() => ({}))) as { runId?: string };
      if (body.runId) {
        runIds.push(body.runId);
      }
    } catch (err) {
      details.push(`POST #${i} exception: ${(err as Error).message}`);
    }
  }

  details.push(`statuses: [${statuses.join(", ")}]`);
  details.push(`runIds: [${runIds.join(", ")}]`);

  const ok =
    statuses.length === 2 &&
    statuses.every((s) => s === 200 || s === 202) &&
    runIds.length === 2 &&
    runIds[0] !== runIds[1];

  if (!ok) {
    if (statuses.some((s) => s !== 200 && s !== 202)) {
      details.push("assertion: expected two 200/202 responses");
    }
    if (runIds.length < 2 || runIds[0] === runIds[1]) {
      details.push("assertion: expected two distinct runIds");
    }
  }

  return {
    name: "Idempotency",
    status: ok ? "pass" : "fail",
    details,
  };
}

// ---------- Main ----------
async function main() {
  console.log(`${BOLD}Straja inbound-flow E2E validation${RESET}`);
  console.log(`started ${new Date().toISOString()}`);
  console.log();

  const start = Date.now();
  const results: SuiteResult[] = [];

  const printSuiteHeader = (i: number, total: number, name: string) => {
    console.log(`${BOLD}[${i}/${total}] ${name}${RESET}`);
    console.log("─".repeat(60));
  };

  const printSuiteFooter = (r: SuiteResult) => {
    for (const d of r.details) {
      console.log(`  ${d}`);
    }
    console.log(`  → ${tag(r.status)}`);
    if (r.nextStep) {
      console.log(`  ${YELLOW}next step: ${r.nextStep}${RESET}`);
    }
    console.log();
  };

  // Suite 1
  printSuiteHeader(1, 4, "Environment & versions");
  const s1 = await suite1().catch((err) => ({
    name: "Environment & versions",
    status: "fail" as SuiteStatus,
    details: [`exception: ${(err as Error).message}`],
  }));
  results.push(s1);
  printSuiteFooter(s1);
  const token = "token" in s1 ? (s1 as { token?: string }).token : undefined;

  // Suite 2
  printSuiteHeader(2, 4, "Flow loading + prepend rendering");
  const s2 = await suite2().catch((err) => ({
    name: "Flow loading + prepend rendering",
    status: "fail" as SuiteStatus,
    details: [`exception: ${(err as Error).message}`],
  }));
  results.push(s2);
  printSuiteFooter(s2);

  // Suite 3
  printSuiteHeader(3, 4, "Live /hooks/agent E2E");
  const s3 = await suite3(token).catch((err) => ({
    name: "Live /hooks/agent E2E",
    status: "fail" as SuiteStatus,
    details: [`exception: ${(err as Error).message}`],
  }));
  results.push(s3);
  printSuiteFooter(s3);

  // Suite 4
  printSuiteHeader(4, 4, "Idempotency");
  const s4 = await suite4(token).catch((err) => ({
    name: "Idempotency",
    status: "fail" as SuiteStatus,
    details: [`exception: ${(err as Error).message}`],
  }));
  results.push(s4);
  printSuiteFooter(s4);

  // Summary
  const elapsed = Date.now() - start;
  console.log("─".repeat(45));
  console.log(` ${BOLD}Suite${RESET}                               ${BOLD}Result${RESET}`);
  console.log("─".repeat(45));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const padded = ` ${i + 1}. ${r.name}`.padEnd(36);
    console.log(`${padded}${tag(r.status)}`);
    if (r.nextStep) {
      console.log(`    ${YELLOW}→ next step: ${r.nextStep}${RESET}`);
    }
  }
  console.log("─".repeat(45));
  const failCount = results.filter((r) => r.status === "fail").length;
  const warnCount = results.filter((r) => r.status === "warn").length;
  const overall =
    failCount > 0
      ? `${RED}${BOLD}FAIL${RESET}`
      : warnCount > 0
        ? `${YELLOW}${BOLD}WARN${RESET}`
        : `${GREEN}${BOLD}PASS${RESET}`;
  console.log(` OVERALL: ${overall} — ${failCount} fail, ${warnCount} warn`);
  console.log(`finished in ${elapsed}ms`);

  process.exit(failCount > 0 ? 1 : 0);
}

// Hard timeout — should never be needed but prevents stuck CI jobs.
setTimeout(() => {
  console.error(`${RED}validator hard-timeout reached${RESET}`);
  process.exit(2);
}, 180_000).unref();

main().catch((err) => {
  console.error(`${RED}fatal: ${(err as Error).message}${RESET}`);
  process.exit(1);
});
