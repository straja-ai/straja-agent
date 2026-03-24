import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import {
  getFlowTestContext,
  recordFlowTestToolCall,
  recordFlowTestVaultMutation,
} from "../../../src/auto-reply/flow-test-context.js";
import { vaultFetch } from "./http.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const VaultSearchSchema = Type.Object({
  query: Type.String({
    description:
      "Natural language question or keywords to search for in the document vault. " +
      "The search runs a hybrid pipeline (keyword + semantic + hypothetical document) for best recall.",
  }),
  collections: Type.Optional(
    Type.Array(Type.String(), {
      description: "Filter to specific collections (by name). Omit to search all.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of results to return (default: 10).",
      minimum: 1,
      maximum: 50,
      default: 10,
    }),
  ),
});

export const VaultGetSchema = Type.Object({
  collection: Type.String({
    description: "Collection name (e.g. 'subaru').",
  }),
  path: Type.String({
    description:
      "File path within the collection, as returned by vault_search " +
      "(e.g. 'subaru-manual.pdf#page-353'). Use the 'file' field from search results.",
  }),
});

export const VaultStatusSchema = Type.Object({});

const SpreadsheetCellValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

export const VaultSpreadsheetGetSchema = Type.Object({
  collection: Type.String({
    description: "Collection name containing the spreadsheet-backed document (e.g. 'elevi').",
  }),
  path: Type.String({
    description:
      "Canonical collection document path or title for the spreadsheet-backed file " +
      "(e.g. 'Prezenta_elevi' or 'Prezenta_elevi.json').",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum rows to return (default: 100, max: 500).",
      minimum: 1,
      maximum: 500,
      default: 100,
    }),
  ),
});

export const VaultSpreadsheetMatchSchema = Type.Object({
  collection: Type.String({
    description: "Collection name containing the spreadsheet-backed document.",
  }),
  path: Type.String({
    description: "Canonical collection document path or title for the spreadsheet-backed file.",
  }),
  value: SpreadsheetCellValueSchema,
  columns: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional list of columns to search. Omit to search all columns.",
    }),
  ),
  mode: Type.Optional(
    Type.Union(
      [
        Type.Literal("exact"),
        Type.Literal("trimmed"),
        Type.Literal("casefold"),
        Type.Literal("digits"),
        Type.Literal("phone"),
      ],
      {
        description:
          "Normalization mode. Use 'phone' for phone numbers (tolerates punctuation and missing country/trunk prefix variants), " +
          "'digits' for strict digits-only matching, 'casefold' for case-insensitive text, " +
          "'trimmed' to ignore outer whitespace.",
        default: "exact",
      },
    ),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum matches to return (default: 20).",
      minimum: 1,
      maximum: 100,
      default: 20,
    }),
  ),
});

export const VaultSpreadsheetUpdateSchema = Type.Object({
  collection: Type.String({
    description: "Collection name containing the spreadsheet-backed document.",
  }),
  path: Type.String({
    description: "Canonical collection document path or title for the spreadsheet-backed file.",
  }),
  rowIndex: Type.Optional(
    Type.Number({
      description: "Zero-based row index to update directly.",
      minimum: 0,
    }),
  ),
  matchValue: Type.Optional(SpreadsheetCellValueSchema),
  matchColumns: Type.Optional(
    Type.Array(Type.String(), {
      description: "Columns to use for matchValue lookup.",
    }),
  ),
  matchMode: Type.Optional(
    Type.Union(
      [
        Type.Literal("exact"),
        Type.Literal("trimmed"),
        Type.Literal("casefold"),
        Type.Literal("digits"),
      ],
      {
        description: "Normalization mode for matchValue lookup.",
        default: "exact",
      },
    ),
  ),
  updates: Type.Record(Type.String(), SpreadsheetCellValueSchema, {
    description: "Column/value updates to apply to the matched row.",
  }),
  createIfMissing: Type.Optional(
    Type.Boolean({
      description: "If true, create a new row when no match is found.",
      default: false,
    }),
  ),
  seedRow: Type.Optional(
    Type.Record(Type.String(), SpreadsheetCellValueSchema, {
      description: "Optional initial row values when createIfMissing is true.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Memory Schemas
// ---------------------------------------------------------------------------

export const VaultMemorySearchSchema = Type.Object({
  query: Type.String({
    description:
      "Natural language query to search persistent memory. " +
      "Runs hybrid search (keyword + semantic + hypothetical document) across the vault's _memory collection.",
  }),
  maxResults: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default: 6).",
      minimum: 1,
      maximum: 20,
      default: 6,
    }),
  ),
  minScore: Type.Optional(
    Type.Number({
      description: "Minimum relevance score threshold (default: 0).",
      minimum: 0,
      maximum: 1,
    }),
  ),
});

export const VaultMemoryGetSchema = Type.Object({
  path: Type.String({
    description:
      "Relative path within the _memory collection (e.g. 'MEMORY.md' or 'memory/2026-02-21.md').",
  }),
  from: Type.Optional(
    Type.Number({
      description: "Start line (1-based). Omit to read from the beginning.",
      minimum: 1,
    }),
  ),
  lines: Type.Optional(
    Type.Number({
      description: "Number of lines to return. Omit to read to the end.",
      minimum: 1,
    }),
  ),
});

export const VaultMemoryWriteSchema = Type.Object({
  path: Type.String({
    description: "Path within the _memory collection (e.g. 'memory/2026-02-21.md' or 'MEMORY.md').",
  }),
  content: Type.String({
    description: "Content to write.",
  }),
  append: Type.Optional(
    Type.Boolean({
      description:
        "If true, append content to the existing file instead of overwriting. " +
        "Use append for incremental memory updates (e.g. pre-compaction flush).",
      default: false,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Artifact Schemas
// ---------------------------------------------------------------------------

export const VaultArtifactWriteSchema = Type.Object({
  path: Type.String({
    description:
      "Relative path within the editable collection (e.g. 'presentations/q1-report/spec.json' or 'reports/weekly-update/spec.json').",
  }),
  content: Type.String({
    description: "Content to write (text or base64-encoded binary).",
  }),
  encoding: Type.Optional(
    Type.Union([Type.Literal("utf8"), Type.Literal("base64")], {
      description: "Content encoding: 'utf8' for text files, 'base64' for binary files.",
      default: "utf8",
    }),
  ),
  mimeType: Type.Optional(
    Type.String({
      description: "MIME type for binary content (e.g. 'image/png').",
    }),
  ),
});

export const VaultArtifactListSchema = Type.Object({
  prefix: Type.Optional(
    Type.String({
      description: "Path prefix filter (e.g. 'presentations/'). Omit to list all artifacts.",
      default: "",
    }),
  ),
});

export const VaultPresentationBuildSchema = Type.Object({
  name: Type.String({
    description:
      "Presentation folder name under presentations/ (e.g. 'quarterly-review'). " +
      "The spec must exist at editable/presentations/<name>/spec.json.",
  }),
});

export const VaultReportBuildSchema = Type.Object({
  name: Type.String({
    description:
      "Report folder name under reports/ (e.g. 'weekly-update'). " +
      "The spec must exist at editable/reports/<name>/spec.json.",
  }),
});

export const VaultArtifactUrlSchema = Type.Object({
  path: Type.String({
    description:
      "Path within the editable collection (e.g. 'presentations/q1-report/build/q1-report.pptx' or 'reports/weekly-update/build/weekly-update.pdf'). " +
      "Returns a time-limited download URL for agent-side use (e.g. sending via Telegram).",
  }),
});

// ---------------------------------------------------------------------------
// Note Schema
// ---------------------------------------------------------------------------

export const VaultNoteCreateSchema = Type.Object({
  title: Type.String({
    description: "Note title.",
  }),
  content: Type.String({
    description: "Note content (markdown supported).",
  }),
});

export const VaultNoteUpdateSchema = Type.Object({
  path: Type.String({
    description:
      "The note's file path in the _notes collection (e.g. 'shopping-list-20260311143022.md'). " +
      "Find this by searching the vault first.",
  }),
  title: Type.String({
    description: "Updated note title.",
  }),
  content: Type.String({
    description: "Updated note content (markdown supported).",
  }),
});

// ---------------------------------------------------------------------------
// Agent Collection Schemas
// ---------------------------------------------------------------------------

export const VaultAgentCollectionCreateSchema = Type.Object({
  name: Type.String({
    description:
      "Name for the new agent collection (e.g. 'john-doe', 'project-alpha'). " +
      "Will be sanitized to a lowercase slug. Must not start with '_' (reserved for system collections).",
  }),
  description: Type.Optional(
    Type.String({
      description: "Short description of the collection's purpose.",
    }),
  ),
});

export const VaultAgentCollectionWriteSchema = Type.Object({
  collection: Type.String({
    description:
      "Agent collection name (as returned by vault_agent_collection_create or vault_agent_collection_list).",
  }),
  path: Type.String({
    description: "File path within the collection (e.g. 'notes/2026-03-10.md').",
  }),
  content: Type.String({
    description: "Content to write.",
  }),
  title: Type.Optional(
    Type.String({
      description: "Human-readable title for the document. Defaults to the path.",
    }),
  ),
  append: Type.Optional(
    Type.Boolean({
      description: "If true, append content instead of overwriting. Default: false.",
      default: false,
    }),
  ),
});

export const VaultCollectionWriteSchema = Type.Object({
  collection: Type.String({
    description:
      "Collection name to write to (for example 'elevi', 'crm', or another writable vault collection).",
  }),
  path: Type.String({
    description:
      "File path within the collection (for example 'Iuliana Manole/2026-03-23-mesaj-parinte.md').",
  }),
  content: Type.String({
    description: "Content to write.",
  }),
  title: Type.Optional(
    Type.String({
      description: "Human-readable title for the document. Defaults to the path.",
    }),
  ),
  append: Type.Optional(
    Type.Boolean({
      description: "If true, append content instead of overwriting. Default: false.",
      default: false,
    }),
  ),
});

export const VaultAgentCollectionListSchema = Type.Object({});

export const VaultWebSearchDuckDuckGoSchema = Type.Object({
  query: Type.String({
    description: "Web search query to run through the vault's DuckDuckGo search adapter.",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of search results to return (default: 5, max: 10).",
      minimum: 1,
      maximum: 10,
      default: 5,
    }),
  ),
});

export const VaultWebFetchSchema = Type.Object({
  url: Type.String({
    description: "HTTP or HTTPS URL to fetch.",
  }),
  extractMode: Type.Optional(
    Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
      description: 'Extraction mode ("markdown" or "text"). Default: "markdown".',
      default: "markdown",
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({
      description: "Maximum characters to return (truncates when exceeded). Default: 50000.",
      minimum: 100,
    }),
  ),
});

export const VaultApproveDomainSchema = Type.Object({
  domain: Type.String({
    description:
      "The domain to approve or remove (e.g. 'bbc.com', 'cnn.com'). " +
      "Use the domain from the blocked-domain error message.",
  }),
  decision: Type.Union([Type.Literal("once"), Type.Literal("always"), Type.Literal("remove")], {
    description:
      '"once" for one-time access (domain stays off the permanent allow list), ' +
      '"always" to add the domain permanently to the allow list, ' +
      '"remove" to revoke a previously approved domain from the allow list.',
  }),
  scope: Type.Optional(
    Type.Union([Type.Literal("web-fetch"), Type.Literal("browser"), Type.Literal("all")], {
      description:
        'Which subsystem to approve: "web-fetch", "browser", or "all" (both). Default: "all".',
      default: "all",
    }),
  ),
  capability: Type.Optional(
    Type.Union([Type.Literal("navigate"), Type.Literal("post"), Type.Literal("all")], {
      description:
        'What to approve: "navigate" for domain allowlist (default), "post" for form submissions, "all" for both.',
      default: "navigate",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Gmail Draft Schema
// ---------------------------------------------------------------------------

export const GmailCreateDraftSchema = Type.Object({
  to: Type.String({
    description: "Recipient email address.",
  }),
  subject: Type.String({
    description: "Email subject line.",
  }),
  body: Type.String({
    description: "Plain-text email body.",
  }),
  inReplyTo: Type.Optional(
    Type.String({
      description:
        "RFC 2822 Message-ID of the email being replied to (from the message_id field in vault email documents). " +
        "Setting this threads the draft as a reply in Gmail.",
    }),
  ),
  references: Type.Optional(
    Type.String({
      description: "References header chain for threading replies.",
    }),
  ),
  threadId: Type.Optional(
    Type.String({
      description:
        "Gmail thread ID to keep the draft in the same conversation thread (from the thread_id field in vault email documents).",
    }),
  ),
});

export const GmailUpdateDraftSchema = Type.Object({
  draftId: Type.String({
    description:
      "The Gmail draft ID to update (returned by vault_gmail_create_draft as 'Draft ID').",
  }),
  to: Type.String({
    description: "Recipient email address.",
  }),
  subject: Type.String({
    description: "Email subject line.",
  }),
  body: Type.String({
    description: "Plain-text email body.",
  }),
  inReplyTo: Type.Optional(
    Type.String({
      description:
        "RFC 2822 Message-ID of the email being replied to (from the message_id field in vault email documents).",
    }),
  ),
  references: Type.Optional(
    Type.String({
      description: "References header chain for threading replies.",
    }),
  ),
  threadId: Type.Optional(
    Type.String({
      description: "Gmail thread ID to keep the draft in the same conversation thread.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// GitHub Schemas
// ---------------------------------------------------------------------------

export const GitHubCreateIssueSchema = Type.Object({
  owner: Type.String({
    description: "Repository owner (user or organization).",
  }),
  repo: Type.String({
    description: "Repository name.",
  }),
  title: Type.String({
    description: "Issue title.",
  }),
  body: Type.Optional(
    Type.String({
      description: "Issue body (markdown).",
    }),
  ),
  labels: Type.Optional(
    Type.Array(Type.String(), {
      description: "Labels to apply to the issue.",
    }),
  ),
});

export const GitHubListIssuesSchema = Type.Object({
  owner: Type.String({
    description: "Repository owner.",
  }),
  repo: Type.String({
    description: "Repository name.",
  }),
  state: Type.Optional(
    Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")], {
      description: "Filter by state. Default: open.",
      default: "open",
    }),
  ),
});

export const GitHubCreateBranchSchema = Type.Object({
  owner: Type.String({
    description: "Repository owner.",
  }),
  repo: Type.String({
    description: "Repository name.",
  }),
  branch: Type.String({
    description: "New branch name (e.g. 'fix/login-bug').",
  }),
  from: Type.Optional(
    Type.String({
      description: "Base branch to create from. Defaults to the repo's default branch.",
    }),
  ),
});

export const GitHubCreatePRSchema = Type.Object({
  owner: Type.String({
    description: "Repository owner.",
  }),
  repo: Type.String({
    description: "Repository name.",
  }),
  title: Type.String({
    description: "Pull request title.",
  }),
  body: Type.Optional(
    Type.String({
      description: "Pull request description (markdown).",
    }),
  ),
  head: Type.String({
    description: "Branch with changes (source branch).",
  }),
  base: Type.Optional(
    Type.String({
      description: "Target branch. Defaults to the repo's default branch.",
    }),
  ),
});

export const GitHubListPRsSchema = Type.Object({
  owner: Type.String({
    description: "Repository owner.",
  }),
  repo: Type.String({
    description: "Repository name.",
  }),
  state: Type.Optional(
    Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")], {
      description: "Filter by state. Default: open.",
      default: "open",
    }),
  ),
});

export const GitHubPushSchema = Type.Object({
  owner: Type.String({
    description: "Repository owner.",
  }),
  repo: Type.String({
    description: "Repository name.",
  }),
  branch: Type.String({
    description: "Target branch to push to. CANNOT be main, master, or the repo's default branch.",
  }),
  files: Type.Array(
    Type.Object({
      path: Type.String({ description: "File path relative to repo root." }),
      content: Type.String({ description: "File content." }),
    }),
    { description: "Files to push." },
  ),
  message: Type.String({
    description: "Commit message.",
  }),
});

// ---------------------------------------------------------------------------
// Repos Schema
// ---------------------------------------------------------------------------

export const ReposListSchema = Type.Object({});

export const RepoExecSchema = Type.Object({
  command: Type.String({
    description:
      "The command to execute (e.g. 'git', 'npm', 'node', 'cargo'). " +
      "Runs inside a sandboxed environment scoped to the repos directory with domain-filtered network access.",
  }),
  args: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Arguments to pass to the command (e.g. ['status', '--porcelain'] or ['run', 'build']).",
    }),
  ),
  cwd: Type.String({
    description:
      "Working directory relative to the repos base (~/.straja/repos/). " +
      "Must be a repo name or path within a repo (e.g. 'my-repo' or 'my-repo/src'). Required.",
  }),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Timeout in seconds. For synchronous mode: 1-300 (default: 30). " +
        "For background mode: 1-1800 (30 min). Command is killed if it exceeds this.",
      minimum: 1,
      maximum: 1800,
      default: 30,
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run the command in background immediately and return a session ID. " +
        "Use vault_process to interact with the running process (poll output, write stdin, kill, etc.).",
    }),
  ),
  yieldMs: Type.Optional(
    Type.Number({
      description:
        "Wait this many milliseconds for the command to complete. " +
        "If still running after this time, background the command and return a session ID.",
      minimum: 10,
      maximum: 120000,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Calendar Event Schemas
// ---------------------------------------------------------------------------

export const CalendarCreateEventSchema = Type.Object({
  calendarId: Type.Optional(
    Type.String({
      description:
        'Google Calendar ID to create the event in. Defaults to "primary". ' +
        "Use the calendar_id from synced event documents to target a specific calendar.",
      default: "primary",
    }),
  ),
  summary: Type.String({
    description: "Event title / summary.",
  }),
  description: Type.Optional(
    Type.String({
      description: "Event description or notes.",
    }),
  ),
  start: Type.String({
    description:
      "Start time in ISO 8601 format (e.g. '2025-03-01T10:00:00+02:00') or date-only for all-day events ('2025-03-01').",
  }),
  end: Type.String({
    description:
      "End time in ISO 8601 format (e.g. '2025-03-01T11:00:00+02:00') or date-only for all-day events ('2025-03-02').",
  }),
  location: Type.Optional(
    Type.String({
      description: "Event location.",
    }),
  ),
  attendees: Type.Optional(
    Type.Array(Type.String(), {
      description: "Email addresses of attendees to invite.",
    }),
  ),
  timeZone: Type.Optional(
    Type.String({
      description:
        "IANA time zone for the event (e.g. 'Europe/Bucharest'). If omitted, uses the calendar's default.",
    }),
  ),
});

export const CalendarUpdateEventSchema = Type.Object({
  calendarId: Type.Optional(
    Type.String({
      description: 'Google Calendar ID containing the event. Defaults to "primary".',
      default: "primary",
    }),
  ),
  eventId: Type.String({
    description:
      "The Google Calendar event ID to update (from the event_id field in vault calendar documents).",
  }),
  summary: Type.Optional(
    Type.String({
      description: "Updated event title.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Updated event description.",
    }),
  ),
  start: Type.Optional(
    Type.String({
      description: "Updated start time in ISO 8601 format.",
    }),
  ),
  end: Type.Optional(
    Type.String({
      description: "Updated end time in ISO 8601 format.",
    }),
  ),
  location: Type.Optional(
    Type.String({
      description: "Updated event location.",
    }),
  ),
  attendees: Type.Optional(
    Type.Array(Type.String(), {
      description: "Updated list of attendee email addresses.",
    }),
  ),
  timeZone: Type.Optional(
    Type.String({
      description: "IANA time zone for the event.",
    }),
  ),
});

export const CalendarDeleteEventSchema = Type.Object({
  calendarId: Type.Optional(
    Type.String({
      description: 'Google Calendar ID containing the event. Defaults to "primary".',
      default: "primary",
    }),
  ),
  eventId: Type.String({
    description:
      "The Google Calendar event ID to delete (from the event_id field in vault calendar documents).",
  }),
});

// ---------------------------------------------------------------------------
// Browser Schemas
// ---------------------------------------------------------------------------

export const BrowserNavigateSchema = Type.Object({
  url: Type.String({ description: "The URL to navigate to." }),
});

export const BrowserSnapshotSchema = Type.Object({});

export const BrowserClickSchema = Type.Object({
  element: Type.String({
    description: "Human-readable description of the element to click (e.g. 'Submit button').",
  }),
  ref: Type.Optional(
    Type.String({ description: "Exact element reference from a previous snapshot." }),
  ),
});

export const BrowserTypeSchema = Type.Object({
  element: Type.String({
    description: "Human-readable description of the editable element to type into.",
  }),
  ref: Type.Optional(
    Type.String({ description: "Exact element reference from a previous snapshot." }),
  ),
  text: Type.String({ description: "Text to type into the element." }),
  submit: Type.Optional(
    Type.Boolean({ description: "Press Enter after typing (default: false)." }),
  ),
});

export const BrowserFillSchema = Type.Object({
  element: Type.String({ description: "Human-readable description of the form field." }),
  ref: Type.Optional(
    Type.String({ description: "Exact element reference from a previous snapshot." }),
  ),
  value: Type.String({
    description: "Value to fill into the field (clears existing content first).",
  }),
});

export const BrowserSelectSchema = Type.Object({
  element: Type.String({
    description: "Human-readable description of the select/dropdown element.",
  }),
  ref: Type.Optional(
    Type.String({ description: "Exact element reference from a previous snapshot." }),
  ),
  values: Type.Array(Type.String(), { description: "Option values to select." }),
});

export const BrowserHoverSchema = Type.Object({
  element: Type.String({ description: "Human-readable description of the element to hover over." }),
  ref: Type.Optional(
    Type.String({ description: "Exact element reference from a previous snapshot." }),
  ),
});

export const BrowserPressKeySchema = Type.Object({
  key: Type.String({
    description: "Key or key combination to press (e.g. 'Enter', 'Escape', 'Control+c').",
  }),
});

export const BrowserScreenshotSchema = Type.Object({});

export const BrowserTabListSchema = Type.Object({});

export const BrowserTabNewSchema = Type.Object({
  url: Type.Optional(Type.String({ description: "URL to open in the new tab." })),
});

export const BrowserTabCloseSchema = Type.Object({
  index: Type.Optional(Type.Number({ description: "Tab index to close (0-based)." })),
});

export const BrowserConsoleSchema = Type.Object({});

export const BrowserWaitSchema = Type.Object({
  text: Type.String({ description: "Text to wait for on the page." }),
  textGone: Type.Optional(Type.String({ description: "Text to wait for disappearance." })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)." })),
});

export const BrowserTabsSchema = Type.Object({
  action: Type.Union(
    [Type.Literal("list"), Type.Literal("new"), Type.Literal("close"), Type.Literal("select")],
    { description: "Tabs action to perform." },
  ),
  index: Type.Optional(
    Type.Number({ description: "Tab index for close/select actions (0-based)." }),
  ),
});

export const BrowserPdfSchema = Type.Object({
  filename: Type.Optional(Type.String({ description: "Optional filename for the generated PDF." })),
});

export const BrowserDialogSchema = Type.Object({
  accept: Type.Boolean({ description: "Accept (true) or dismiss (false) the dialog." }),
  promptText: Type.Optional(
    Type.String({ description: "Prompt text when handling a prompt dialog." }),
  ),
});

export const BrowserUploadSchema = Type.Object({
  collection: Type.Optional(
    Type.String({
      description: "Vault collection containing the file to upload (typically '_uploads').",
    }),
  ),
  path: Type.Optional(Type.String({ description: "Path to the file inside the collection." })),
  mediaUrl: Type.Optional(
    Type.String({
      description:
        "Optional vault media URL (for example from inbound Telegram media). If provided, the file is staged into '_uploads' before upload.",
    }),
  ),
  mediaPath: Type.Optional(
    Type.String({
      description:
        "Optional vault media reference (for example '_media/<id>' or '/media/<id>'). If provided, the file is staged into '_uploads' before upload.",
    }),
  ),
  stagePath: Type.Optional(
    Type.String({
      description:
        "Optional target path inside '_uploads' when staging from media. If omitted, a safe inbound path is generated automatically.",
    }),
  ),
  overwrite: Type.Optional(
    Type.Boolean({
      description:
        "When staging from media, overwrite an existing file at stagePath if true. Ignored for direct collection/path uploads.",
    }),
  ),
});

export const BrowserStageMediaUploadSchema = Type.Object({
  mediaUrl: Type.Optional(
    Type.String({
      description:
        "Vault media URL to stage into '_uploads' (for example from inbound Telegram media).",
    }),
  ),
  mediaPath: Type.Optional(
    Type.String({
      description:
        "Vault media reference to stage into '_uploads' (for example '_media/<id>' or '/media/<id>').",
    }),
  ),
  path: Type.Optional(
    Type.String({
      description:
        "Optional target path inside '_uploads'. If omitted, a safe inbound path is generated automatically.",
    }),
  ),
  overwrite: Type.Optional(
    Type.Boolean({
      description: "Overwrite an existing staged upload file if true.",
    }),
  ),
});

export const BrowserStatusSchema = Type.Object({});
export const BrowserStartSchema = Type.Object({});
export const BrowserStopSchema = Type.Object({});

export const VaultExecSchema = Type.Object({
  command: Type.String({
    description:
      "The command to execute (e.g. 'python3', 'node', 'sh', 'grep'). " +
      "The command runs inside a kernel-enforced sandbox with access only to workspace files.",
  }),
  args: Type.Optional(
    Type.Array(Type.String(), {
      description: "Arguments to pass to the command (e.g. ['script.py'] or ['-c', 'echo hello']).",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Timeout in seconds. For synchronous mode: 1-300 (default: 30). " +
        "For background mode: 1-1800 (30 min). Command is killed if it exceeds this.",
      minimum: 1,
      maximum: 1800,
      default: 30,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory relative to workspace root (e.g. 'src' or 'tests'). Defaults to workspace root.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run the command in background immediately and return a session ID. " +
        "Use vault_process to interact with the running process (poll output, write stdin, kill, etc.).",
    }),
  ),
  yieldMs: Type.Optional(
    Type.Number({
      description:
        "Wait this many milliseconds for the command to complete. " +
        "If still running after this time, background the command and return a session ID. " +
        "Use vault_process to interact with backgrounded processes.",
      minimum: 10,
      maximum: 120000,
    }),
  ),
});

export const VaultProcessSchema = Type.Object({
  action: Type.String({
    description:
      "Process management action: " +
      "list (show all sessions), " +
      "poll (drain new output from a session), " +
      "log (get full aggregated output), " +
      "write (send data to stdin), " +
      "kill (terminate a running process), " +
      "clear (remove a finished session), " +
      "remove (kill if running + remove session).",
  }),
  sessionId: Type.Optional(
    Type.String({
      description:
        "Session ID (required for all actions except 'list'). Returned by vault_exec in background mode.",
    }),
  ),
  data: Type.Optional(
    Type.String({
      description: "Data to write to the process stdin (for 'write' action).",
    }),
  ),
  eof: Type.Optional(
    Type.Boolean({
      description: "Close stdin after writing data (for 'write' action).",
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description: "Line offset for 'log' action (0-based, default: 0).",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of lines to return for 'log' action (default: 200).",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description:
        "For 'poll' action: wait up to this many milliseconds for the process to produce output or exit. " +
        "0 means return immediately (default: 0).",
      minimum: 0,
      maximum: 120000,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Execute functions
// ---------------------------------------------------------------------------

type SearchResult = {
  docid: string;
  file: string;
  title: string;
  score: number;
  context: string | null;
  snippet: string;
};

type ArtifactItem = {
  path: string;
  modifiedAt: string;
  size: number;
  mimeType: string;
  isBinary: boolean;
};

function normalizeEditableArtifactPath(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^_?editable\//i, "");
}

export type VaultToolsOptions = {
  onMemoryWrite?: (path: string) => void;
};

export function createVaultTools(baseUrl: string, options?: VaultToolsOptions): AnyAgentTool[] {
  function summarizeToolValue(value: unknown, depth = 0): unknown {
    if (
      value == null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (depth > 2) {
      return "[truncated]";
    }
    if (Array.isArray(value)) {
      return value.slice(0, 5).map((item) => summarizeToolValue(item, depth + 1));
    }
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      const entries = Object.entries(value as Record<string, unknown>).slice(0, 12);
      for (const [key, item] of entries) {
        out[key] = summarizeToolValue(item, depth + 1);
      }
      return out;
    }
    return String(value);
  }

  function withFlowTestRecording(tool: AnyAgentTool): AnyAgentTool {
    return {
      ...tool,
      async execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
        try {
          const result = await tool.execute(toolCallId, params, signal);
          recordFlowTestToolCall({
            name: tool.name,
            params: summarizeToolValue(params),
            outcome: "success",
            result: summarizeToolValue(result),
          });
          return result;
        } catch (err) {
          recordFlowTestToolCall({
            name: tool.name,
            params: summarizeToolValue(params),
            outcome: "error",
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    };
  }

  // -- vault_search -----------------------------------------------------------
  const vaultSearch: AnyAgentTool = {
    name: "vault_search",
    label: "Vault Search",
    description:
      "Search the Straja Vault document collections using hybrid retrieval " +
      "(keyword + semantic + hypothetical document). Returns ranked results " +
      "with titles, relevance scores, and text snippets. " +
      "Use vault_get to read the full content of a specific result. " +
      "If the user already names a collection and likely document title/path, use this to resolve it; do not ask the user to upload the file or provide a local filesystem path first.",
    parameters: VaultSearchSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const query = String(params.query || "");
      if (!query) {
        return { content: [{ type: "text" as const, text: "Error: query is required." }] };
      }

      const collections = params.collections as string[] | undefined;
      const limit = (params.limit as number) ?? 10;

      // Build hybrid sub-searches for best recall
      const searches = [
        { type: "lex", query },
        { type: "vec", query },
        { type: "hyde", query },
      ];

      const payload: Record<string, unknown> = { searches, limit };
      if (collections && collections.length > 0) {
        payload.collections = collections;
      }

      try {
        const resp = await vaultFetch(`${baseUrl}/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [{ type: "text" as const, text: `Vault error (${resp.status}): ${errText}` }],
          };
        }

        const data = (await resp.json()) as { results: SearchResult[] };
        const results = data.results || [];

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No results found." }],
          };
        }

        // Format results for the LLM
        const lines = results.map((r, i) => {
          const hasSourceAsset = r.snippet.includes("_source_asset");
          const tag = hasSourceAsset
            ? " [spreadsheet-backed document — prefer vault_spreadsheet_get/match/update]"
            : "";
          return `[${i + 1}] ${r.title} (${r.file}) — score: ${r.score}${tag}\n${r.snippet}`;
        });
        const text = `Found ${results.length} result(s):\n\n${lines.join("\n\n")}`;

        return {
          content: [{ type: "text" as const, text }],
          details: { results },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_get --------------------------------------------------------------
  const vaultGet: AnyAgentTool = {
    name: "vault_get",
    label: "Vault Get Document",
    description:
      "Retrieve the full text content of a document from Straja Vault. " +
      "Use the collection name and file path from vault_search results. " +
      "If the user names a collection and document directly, you can use this access path immediately without asking for an upload or local path. " +
      "Some documents (e.g. Google Drive spreadsheets) are JSON indexes " +
      "with a _source_asset field pointing to the original binary file. " +
      "When you see _source_asset on a spreadsheet-backed document, prefer " +
      "vault_spreadsheet_get, vault_spreadsheet_match, and vault_spreadsheet_update " +
      "instead of vault_exec. Use vault_exec only for true raw binary workflows.",
    parameters: VaultGetSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const collection = String(params.collection || "");
      const path = String(params.path || "");

      if (!collection || !path) {
        return {
          content: [{ type: "text" as const, text: "Error: collection and path are required." }],
        };
      }

      // The file field from search results is "collection/path" — strip the collection prefix if present
      const cleanPath = path.startsWith(`${collection}/`)
        ? path.slice(collection.length + 1)
        : path;

      try {
        const url = `${baseUrl}/collections/${encodeURIComponent(collection)}/files/${encodeURIComponent(cleanPath)}`;
        const resp = await vaultFetch(url, { signal });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [{ type: "text" as const, text: `Vault error (${resp.status}): ${errText}` }],
          };
        }

        const data = (await resp.json()) as {
          path: string;
          displayPath: string;
          title: string;
          content: string;
          docid: string;
        };

        // Detect _source_asset in the document content — this means the JSON
        // is an index for a binary original file (e.g. xlsx from Google Drive).
        // Add a prominent hint so the agent knows to use the original file.
        let sourceAssetHint = "";
        try {
          const parsed = JSON.parse(data.content);
          if (parsed && typeof parsed._source_asset === "string") {
            sourceAssetHint =
              `\n\n⚠️ IMPORTANT: This document is spreadsheet-backed. ` +
              `Prefer vault_spreadsheet_get to inspect rows, vault_spreadsheet_match to locate rows, ` +
              `and vault_spreadsheet_update to modify data and regenerate the linked original asset. ` +
              `The linked original asset path is: ${parsed._source_asset}`;
          }
        } catch {
          // Not JSON — no hint needed
        }

        const text = `# ${data.title}\n\nPath: ${data.displayPath}\nDoc ID: ${data.docid}\n\n${data.content}${sourceAssetHint}`;

        return {
          content: [{ type: "text" as const, text }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_spreadsheet_get --------------------------------------------------
  const vaultSpreadsheetGet: AnyAgentTool = {
    name: "vault_spreadsheet_get",
    label: "Vault Spreadsheet Get",
    description:
      "Read structured rows from a spreadsheet-backed collection document. " +
      "Use this for imported Google Sheets, xlsx, xls, or csv files that appear in a collection as parsed documents. " +
      "This is the preferred inspection path instead of vault_exec. " +
      "If the user names the collection and spreadsheet-backed document, use this directly; do not claim you lack access or ask for the file to be uploaded first.",
    parameters: VaultSpreadsheetGetSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      try {
        const resp = await vaultFetch(`${baseUrl}/spreadsheets/get`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
          signal,
        });
        if (!resp.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Spreadsheet get error (${resp.status}): ${await resp.text()}`,
              },
            ],
          };
        }
        const data = (await resp.json()) as {
          collection: string;
          path: string;
          title: string;
          rowCount: number;
          columns: string[];
          rows: Array<Record<string, unknown>>;
          sourceAsset?: string | null;
          truncated?: boolean;
        };
        const header = `Spreadsheet ${data.collection}/${data.path} — ${data.rowCount} row(s), ${data.columns.length} column(s).`;
        const detail = JSON.stringify(
          {
            columns: data.columns,
            rows: data.rows,
            sourceAsset: data.sourceAsset ?? null,
            truncated: Boolean(data.truncated),
          },
          null,
          2,
        );
        return {
          content: [{ type: "text" as const, text: `${header}\n${detail}` }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_spreadsheet_match ------------------------------------------------
  const vaultSpreadsheetMatch: AnyAgentTool = {
    name: "vault_spreadsheet_match",
    label: "Vault Spreadsheet Match",
    description:
      "Find matching rows in a spreadsheet-backed collection document. " +
      "Use mode='phone' for phone numbers and similar sender/contact identifiers. " +
      "This is the preferred way to map a sender to a student/contact row. " +
      "If the user already named the collection and spreadsheet doc, use this directly rather than asking for manual file access.",
    parameters: VaultSpreadsheetMatchSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      try {
        const resp = await vaultFetch(`${baseUrl}/spreadsheets/match`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
          signal,
        });
        if (!resp.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Spreadsheet match error (${resp.status}): ${await resp.text()}`,
              },
            ],
          };
        }
        const data = (await resp.json()) as {
          collection: string;
          path: string;
          rowCount: number;
          columns: string[];
          matchValue: string;
          mode: string;
          matches: Array<{
            rowIndex: number;
            matchedColumns: string[];
            row: Record<string, unknown>;
          }>;
          truncated?: boolean;
          sourceAsset?: string | null;
        };
        const text = [
          `Spreadsheet matches in ${data.collection}/${data.path}: ${data.matches.length}`,
          `mode=${data.mode} value=${JSON.stringify(data.matchValue)}`,
          JSON.stringify(
            {
              columns: data.columns,
              matches: data.matches,
              truncated: Boolean(data.truncated),
              sourceAsset: data.sourceAsset ?? null,
            },
            null,
            2,
          ),
        ].join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_spreadsheet_update -----------------------------------------------
  const vaultSpreadsheetUpdate: AnyAgentTool = {
    name: "vault_spreadsheet_update",
    label: "Vault Spreadsheet Update",
    description:
      "Update a row in a spreadsheet-backed collection document and regenerate the linked original spreadsheet asset when one exists. " +
      "Use rowIndex directly or matchValue + matchColumns. Set createIfMissing=true to append a new row when needed. " +
      "Prefer this instead of vault_exec for spreadsheet edits. " +
      "If the user names the collection and spreadsheet-backed document, use this workflow instead of asking for an upload or local repo path.",
    parameters: VaultSpreadsheetUpdateSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      try {
        const requestBody = JSON.stringify(params);
        const resp = await vaultFetch(`${baseUrl}/spreadsheets/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
          signal,
        });
        if (!resp.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Spreadsheet update error (${resp.status}): ${await resp.text()}`,
              },
            ],
          };
        }
        const data = (await resp.json()) as {
          updated: boolean;
          collection: string;
          path: string;
          rowIndex: number;
          row: Record<string, unknown>;
          assetUpdated?: boolean;
          assetPath?: string | null;
        };
        const flowTestCtx = getFlowTestContext();
        if (flowTestCtx) {
          const alreadyCaptured = flowTestCtx.capture.vaultMutations.some(
            (entry) =>
              entry.method === "POST" && String(entry.url ?? "").includes("/spreadsheets/update"),
          );
          if (!alreadyCaptured) {
            recordFlowTestVaultMutation({
              method: "POST",
              url: `${baseUrl}/spreadsheets/update`,
              status: flowTestCtx.mode === "apply" ? "applied" : "captured",
              bodyPreview: requestBody.slice(0, 1000),
              bodyBytes: Buffer.byteLength(requestBody),
            });
          }
        }
        const parts = [
          `Updated spreadsheet row ${data.rowIndex} in ${data.collection}/${data.path}.`,
          JSON.stringify(
            {
              row: data.row,
              assetUpdated: Boolean(data.assetUpdated),
              assetPath: data.assetPath ?? null,
            },
            null,
            2,
          ),
        ];
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_status -----------------------------------------------------------
  const vaultStatus: AnyAgentTool = {
    name: "vault_status",
    label: "Vault Status",
    description:
      "Show the status of the Straja Vault index: collections, document counts, and health.",
    parameters: VaultStatusSchema,
    async execute(_toolCallId: string, _params: Record<string, unknown>, signal?: AbortSignal) {
      try {
        const resp = await vaultFetch(`${baseUrl}/status`, { signal });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [{ type: "text" as const, text: `Vault error (${resp.status}): ${errText}` }],
          };
        }

        const data = await resp.json();
        const text = JSON.stringify(data, null, 2);

        return {
          content: [{ type: "text" as const, text: `Vault status:\n${text}` }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_exec --------------------------------------------------------------
  const vaultExec: AnyAgentTool = {
    name: "vault_exec",
    label: "Vault Execute",
    description:
      "Execute a command in a sandboxed environment with access to workspace files. " +
      "The vault materializes all workspace files into a temporary directory, " +
      "including binary assets from the editable collection (e.g. original xlsx files under gdrive/), " +
      "runs the command in a kernel-enforced sandbox (nono), " +
      "and captures any new or modified files back into the vault. " +
      "Use this to run scripts, tests, builds, or any command that operates on workspace files. " +
      "The command cannot access the host filesystem outside the workspace. " +
      "Pre-installed Node.js libraries are available via require(): xlsx (spreadsheet parsing), " +
      "and other vault-bundled packages. Prefer `node -e \"...\"` with require('xlsx') " +
      "for spreadsheet processing instead of writing manual parsers. " +
      "Do NOT use this to search for user information stored in Vault collections, notes, spreadsheets, or memory. " +
      "For retrieval, use vault_search, vault_get, vault_spreadsheet_get, or vault_spreadsheet_match first. " +
      "Commands that complete within 5 seconds return results immediately. " +
      "Longer-running commands are automatically backgrounded — " +
      "use vault_process to poll output, write stdin, or kill the process. " +
      "Set background: true to background immediately without waiting.",
    parameters: VaultExecSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const command = String(params.command || "");
      if (!command) {
        return {
          content: [{ type: "text" as const, text: "Error: command is required." }],
        };
      }

      const payload: Record<string, unknown> = {
        command,
        args: (params.args as string[]) ?? [],
        timeout: (params.timeout as number) ?? 30,
      };
      if (params.cwd) {
        payload.cwd = String(params.cwd);
      }
      if (params.background === true) {
        payload.background = true;
      }
      // Default yieldMs: if the model didn't explicitly set background or yieldMs,
      // auto-yield after 5 seconds so long-running commands don't block the conversation.
      // The model can still set background: true for immediate backgrounding,
      // or yieldMs for a custom wait time.
      if (typeof params.yieldMs === "number") {
        payload.yieldMs = params.yieldMs;
      } else if (params.background !== true) {
        payload.yieldMs = 5000;
      }

      try {
        const resp = await vaultFetch(`${baseUrl}/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Vault exec error (${resp.status}): ${errText}` },
            ],
          };
        }

        const data = (await resp.json()) as Record<string, unknown>;

        // Background mode: process is running, return session info
        if (data.status === "running") {
          const text =
            `Command running in background.\n` +
            `Session ID: ${data.sessionId}\n` +
            `PID: ${data.pid}\n` +
            `Use vault_process to interact (poll, log, write, kill, clear, remove).`;
          return {
            content: [{ type: "text" as const, text }],
            details: data,
          };
        }

        // Synchronous mode: command completed
        const parts: string[] = [];

        if (data.timedOut) {
          parts.push("⚠ Command timed out and was killed.");
        }

        parts.push(`Exit code: ${data.exitCode}`);

        const stdout = String(data.stdout || "").trim();
        const stderr = String(data.stderr || "").trim();

        if (stdout) {
          parts.push(`\nStdout:\n${stdout}`);
        }

        if (stderr) {
          parts.push(`\nStderr:\n${stderr}`);
        }

        const filesChanged = (data.filesChanged as { path: string; action: string }[]) || [];
        if (filesChanged.length > 0) {
          const changes = filesChanged.map((f) => `  ${f.action}: ${f.path}`).join("\n");
          parts.push(`\nFiles changed (${filesChanged.length}):\n${changes}`);
        } else {
          parts.push("\nNo files were changed.");
        }

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_process -----------------------------------------------------------
  const vaultProcess: AnyAgentTool = {
    name: "vault_process",
    label: "Vault Process Manager",
    description:
      "Manage background processes launched by vault_exec. " +
      "Actions: list (show all sessions), poll (drain new output), log (full output), " +
      "write (send data to stdin), kill (terminate process), " +
      "clear/remove (clean up session).",
    parameters: VaultProcessSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const action = String(params.action || "")
        .trim()
        .toLowerCase();
      const sessionId = params.sessionId ? String(params.sessionId) : undefined;

      if (!action) {
        return {
          content: [{ type: "text" as const, text: "Error: action is required." }],
        };
      }

      // PTY-specific actions not supported in vault (nono doesn't allocate PTY)
      if (["send-keys", "submit", "paste"].includes(action)) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Action '${action}' is not supported in vault execution (no PTY). ` +
                `Use 'write' to send data to stdin instead.`,
            },
          ],
        };
      }

      try {
        switch (action) {
          case "list": {
            const resp = await vaultFetch(`${baseUrl}/exec/sessions`, { signal });
            if (!resp.ok) {
              return {
                content: [
                  { type: "text" as const, text: `Error (${resp.status}): ${await resp.text()}` },
                ],
              };
            }
            const data = (await resp.json()) as { sessions: Array<Record<string, unknown>> };
            if (!data.sessions || data.sessions.length === 0) {
              return {
                content: [{ type: "text" as const, text: "No active sessions." }],
              };
            }
            const lines = data.sessions.map((s) => {
              const runtime = s.runtimeMs ? `${Math.round((s.runtimeMs as number) / 1000)}s` : "?";
              if (s.status === "running") {
                return `  [${s.id}] ${s.command} — running (${runtime}) pid=${s.pid}\n    tail: ${s.tail || "(no output)"}`;
              }
              return (
                `  [${s.id}] ${s.command} — ${s.status} exit=${s.exitCode} (${runtime})` +
                (s.timedOut ? " TIMED OUT" : "")
              );
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Sessions (${data.sessions.length}):\n${lines.join("\n")}`,
                },
              ],
              details: data,
            };
          }

          case "poll": {
            if (!sessionId) {
              return {
                content: [
                  { type: "text" as const, text: "Error: sessionId is required for poll." },
                ],
              };
            }
            const timeout = typeof params.timeout === "number" ? params.timeout : 0;
            const url = `${baseUrl}/exec/sessions/${encodeURIComponent(sessionId)}/poll?timeout=${timeout}`;
            const resp = await vaultFetch(url, { signal });
            if (!resp.ok) {
              return {
                content: [
                  { type: "text" as const, text: `Error (${resp.status}): ${await resp.text()}` },
                ],
              };
            }
            const data = (await resp.json()) as Record<string, unknown>;
            const parts: string[] = [];
            const stdout = String(data.stdout || "").trim();
            const stderr = String(data.stderr || "").trim();
            if (stdout) parts.push(`Stdout:\n${stdout}`);
            if (stderr) parts.push(`Stderr:\n${stderr}`);
            if (!stdout && !stderr) parts.push("(no new output)");
            if (data.exited) {
              parts.push(
                `\nProcess exited with code ${data.exitCode}${data.timedOut ? " (timed out)" : ""}`,
              );
              const filesChanged = data.filesChanged as Array<{
                path: string;
                action: string;
              }> | null;
              if (filesChanged && filesChanged.length > 0) {
                const changes = filesChanged.map((f) => `  ${f.action}: ${f.path}`).join("\n");
                parts.push(`Files changed (${filesChanged.length}):\n${changes}`);
              }
            }
            return {
              content: [{ type: "text" as const, text: parts.join("\n") }],
              details: data,
            };
          }

          case "log": {
            if (!sessionId) {
              return {
                content: [{ type: "text" as const, text: "Error: sessionId is required for log." }],
              };
            }
            const offset = typeof params.offset === "number" ? params.offset : 0;
            const limit = typeof params.limit === "number" ? params.limit : 200;
            const url = `${baseUrl}/exec/sessions/${encodeURIComponent(sessionId)}/log?offset=${offset}&limit=${limit}`;
            const resp = await vaultFetch(url, { signal });
            if (!resp.ok) {
              return {
                content: [
                  { type: "text" as const, text: `Error (${resp.status}): ${await resp.text()}` },
                ],
              };
            }
            const data = (await resp.json()) as Record<string, unknown>;
            const parts: string[] = [];
            const logContent = String(data.log || "");
            parts.push(logContent || "(empty log)");
            parts.push(
              `\nTotal lines: ${data.totalLines}, chars: ${data.totalChars}${data.truncated ? " (truncated)" : ""}`,
            );
            if (data.exited) {
              parts.push(`Process exited with code ${data.exitCode}`);
            }
            return {
              content: [{ type: "text" as const, text: parts.join("\n") }],
              details: data,
            };
          }

          case "write": {
            if (!sessionId) {
              return {
                content: [
                  { type: "text" as const, text: "Error: sessionId is required for write." },
                ],
              };
            }
            const writePayload: Record<string, unknown> = {};
            if (params.data !== undefined) writePayload.data = String(params.data);
            if (params.eof === true) writePayload.eof = true;

            const resp = await vaultFetch(
              `${baseUrl}/exec/sessions/${encodeURIComponent(sessionId)}/write`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(writePayload),
                signal,
              },
            );
            if (!resp.ok) {
              return {
                content: [
                  { type: "text" as const, text: `Error (${resp.status}): ${await resp.text()}` },
                ],
              };
            }
            const data = (await resp.json()) as Record<string, unknown>;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Wrote ${data.bytes} bytes to stdin.${params.eof ? " (stdin closed)" : ""}`,
                },
              ],
              details: data,
            };
          }

          case "kill": {
            if (!sessionId) {
              return {
                content: [
                  { type: "text" as const, text: "Error: sessionId is required for kill." },
                ],
              };
            }
            const resp = await vaultFetch(
              `${baseUrl}/exec/sessions/${encodeURIComponent(sessionId)}/kill`,
              {
                method: "POST",
                signal,
              },
            );
            if (!resp.ok) {
              return {
                content: [
                  { type: "text" as const, text: `Error (${resp.status}): ${await resp.text()}` },
                ],
              };
            }
            const data = (await resp.json()) as Record<string, unknown>;
            const parts: string[] = ["Process killed."];
            if (data.exited) {
              parts.push(`Exit code: ${data.exitCode}`);
            }
            const filesChanged = data.filesChanged as Array<{
              path: string;
              action: string;
            }> | null;
            if (filesChanged && filesChanged.length > 0) {
              const changes = filesChanged.map((f) => `  ${f.action}: ${f.path}`).join("\n");
              parts.push(`Files changed (${filesChanged.length}):\n${changes}`);
            }
            return {
              content: [{ type: "text" as const, text: parts.join("\n") }],
              details: data,
            };
          }

          case "clear":
          case "remove": {
            if (!sessionId) {
              return {
                content: [
                  { type: "text" as const, text: `Error: sessionId is required for ${action}.` },
                ],
              };
            }
            const resp = await vaultFetch(
              `${baseUrl}/exec/sessions/${encodeURIComponent(sessionId)}`,
              {
                method: "DELETE",
                signal,
              },
            );
            if (!resp.ok) {
              return {
                content: [
                  { type: "text" as const, text: `Error (${resp.status}): ${await resp.text()}` },
                ],
              };
            }
            return {
              content: [{ type: "text" as const, text: `Session ${sessionId} removed.` }],
            };
          }

          default:
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown action: '${action}'. Valid actions: list, poll, log, write, kill, clear, remove.`,
                },
              ],
            };
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_memory_search ----------------------------------------------------
  const vaultMemorySearch: AnyAgentTool = {
    name: "vault_memory_search",
    label: "Memory Search",
    description:
      "Mandatory recall step: semantically search persistent memory " +
      "(MEMORY.md + memory/*.md stored in the vault's _memory collection) before answering " +
      "questions about prior work, decisions, dates, people, preferences, or todos. " +
      "Returns top snippets with path and relevance scores.",
    parameters: VaultMemorySearchSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const query = String(params.query || "");
      if (!query) {
        return { content: [{ type: "text" as const, text: "Error: query is required." }] };
      }

      const maxResults = (params.maxResults as number) ?? 6;
      const minScore = params.minScore as number | undefined;

      const searches = [
        { type: "lex", query },
        { type: "vec", query },
        { type: "hyde", query },
      ];

      const payload: Record<string, unknown> = {
        searches,
        collections: ["_memory"],
        limit: maxResults,
      };
      if (minScore !== undefined) {
        payload.minScore = minScore;
      }

      try {
        const resp = await vaultFetch(`${baseUrl}/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Memory search error (${resp.status}): ${errText}` },
            ],
          };
        }

        const data = (await resp.json()) as { results: SearchResult[] };
        const results = data.results || [];

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No memory results found." }],
          };
        }

        const lines = results.map(
          (r, i) => `[${i + 1}] ${r.file} — score: ${r.score}\n${r.snippet}`,
        );
        const text = `Found ${results.length} memory result(s):\n\n${lines.join("\n\n")}`;

        return {
          content: [{ type: "text" as const, text }],
          details: { results },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_memory_get -------------------------------------------------------
  const vaultMemoryGet: AnyAgentTool = {
    name: "vault_memory_get",
    label: "Memory Get",
    description:
      "Read a specific memory file from the vault's _memory collection with optional " +
      "from/lines slicing. Use after vault_memory_search to pull only the needed lines " +
      "and keep context small.",
    parameters: VaultMemoryGetSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const path = normalizeEditableArtifactPath(String(params.path || ""));
      if (!path) {
        return { content: [{ type: "text" as const, text: "Error: path is required." }] };
      }

      const from = params.from as number | undefined;
      const lineCount = params.lines as number | undefined;

      try {
        const url = `${baseUrl}/raw/_memory/${encodeURIComponent(path)}`;
        const resp = await vaultFetch(url, { signal });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Memory get error (${resp.status}): ${errText}` },
            ],
          };
        }

        let text = await resp.text();

        // Apply from/lines slicing if specified
        if (from !== undefined || lineCount !== undefined) {
          const allLines = text.split("\n");
          const startIdx = from ? from - 1 : 0; // from is 1-based
          const endIdx = lineCount !== undefined ? startIdx + lineCount : allLines.length;
          text = allLines.slice(startIdx, endIdx).join("\n");
        }

        return {
          content: [{ type: "text" as const, text }],
          details: { path, text },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_memory_write -----------------------------------------------------
  const vaultMemoryWrite: AnyAgentTool = {
    name: "vault_memory_write",
    label: "Memory Write",
    description:
      "Write or append to a memory file in the vault's _memory collection. " +
      "Use path like 'memory/2026-02-21.md' or 'MEMORY.md'. " +
      "Set append: true to add content without overwriting existing entries.",
    parameters: VaultMemoryWriteSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const path = String(params.path || "");
      const content = String(params.content ?? "");
      const append = Boolean(params.append);

      if (!path) {
        return { content: [{ type: "text" as const, text: "Error: path is required." }] };
      }
      if (!content) {
        return { content: [{ type: "text" as const, text: "Error: content is required." }] };
      }

      try {
        const encodedPath = encodeURIComponent(path);
        let resp: Response;

        if (append) {
          resp = await vaultFetch(`${baseUrl}/raw/_memory/${encodedPath}/append`, {
            method: "POST",
            body: content,
            signal,
          });
        } else {
          resp = await vaultFetch(`${baseUrl}/raw/_memory/${encodedPath}`, {
            method: "PUT",
            body: content,
            signal,
          });
        }

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Memory write error (${resp.status}): ${errText}` },
            ],
          };
        }

        // Fire-and-forget: trigger embedding for the new/updated memory
        vaultFetch(`${baseUrl}/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).catch(() => {});

        // Invalidate the MEMORY.md cache so the next prompt build picks up changes
        options?.onMemoryWrite?.(path);

        const action = append ? "appended to" : "wrote";
        return {
          content: [{ type: "text" as const, text: `Successfully ${action} _memory/${path}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_note_create -------------------------------------------------------
  const vaultNoteCreate: AnyAgentTool = {
    name: "vault_note_create",
    label: "Create Note",
    description:
      "Create a note in the vault's _notes collection. " +
      "Use this whenever the user asks to create, save, or jot down a note. " +
      "Notes are stored as markdown files and are automatically embedded for semantic search.",
    parameters: VaultNoteCreateSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const title = String(params.title || "").trim();
      const content = String(params.content ?? "").trim();

      if (!title) {
        return { content: [{ type: "text" as const, text: "Error: title is required." }] };
      }
      if (!content) {
        return { content: [{ type: "text" as const, text: "Error: content is required." }] };
      }

      try {
        const resp = await vaultFetch(`${baseUrl}/notes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content }),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Note creation error (${resp.status}): ${errText}` },
            ],
          };
        }

        const result = (await resp.json()) as { path: string; title: string; size: number };
        return {
          content: [
            {
              type: "text" as const,
              text: `Created note "${result.title}" in _notes collection (${result.path}, ${result.size} bytes).`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_note_update -------------------------------------------------------
  const vaultNoteUpdate: AnyAgentTool = {
    name: "vault_note_update",
    label: "Update Note",
    description:
      "Update an existing note in the vault's _notes collection. " +
      "Use this when the user asks to edit, update, or modify a note. " +
      "You must provide the exact path of the note, which you can find by searching the vault.",
    parameters: VaultNoteUpdateSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const path = String(params.path || "").trim();
      const title = String(params.title || "").trim();
      const content = String(params.content ?? "").trim();

      if (!path) {
        return { content: [{ type: "text" as const, text: "Error: path is required." }] };
      }
      if (!title) {
        return { content: [{ type: "text" as const, text: "Error: title is required." }] };
      }
      if (!content) {
        return { content: [{ type: "text" as const, text: "Error: content is required." }] };
      }

      try {
        const resp = await vaultFetch(`${baseUrl}/notes/${encodeURIComponent(path)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content }),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Note update error (${resp.status}): ${errText}` },
            ],
          };
        }

        const result = (await resp.json()) as { path: string; title: string; size: number };
        return {
          content: [
            {
              type: "text" as const,
              text: `Updated note "${result.title}" in _notes collection (${result.path}, ${result.size} bytes).`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_agent_collection_create -------------------------------------------
  const vaultAgentCollectionCreate: AnyAgentTool = {
    name: "vault_agent_collection_create",
    label: "Create Agent Collection",
    description:
      "Create a new agent-managed collection in the vault (e.g. one per student, project, or topic). " +
      "The collection is marked with metadata so it's distinguishable from user-created collections. " +
      "After creation, use vault_agent_collection_write to add content.",
    parameters: VaultAgentCollectionCreateSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const rawName = String(params.name || "").trim();
      const description = params.description ? String(params.description).trim() : "";

      if (!rawName) {
        return { content: [{ type: "text" as const, text: "Error: name is required." }] };
      }

      // Sanitize to slug
      const collName = rawName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 100);

      if (!collName) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: name produces an empty slug after sanitization.",
            },
          ],
        };
      }
      if (collName.startsWith("_")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: collection name must not start with '_' (reserved for system collections).",
            },
          ],
        };
      }

      try {
        // Check if _meta.json already exists (collection already created)
        const checkResp = await vaultFetch(
          `${baseUrl}/raw/${encodeURIComponent(collName)}/${encodeURIComponent("_meta.json")}`,
          {
            method: "GET",
            signal,
          },
        );
        if (checkResp.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: agent collection "${collName}" already exists.`,
              },
            ],
          };
        }

        // Create _meta.json to mark this as an agent collection
        const meta = JSON.stringify({
          source: "agent",
          description: description || undefined,
          createdAt: new Date().toISOString(),
        });

        const resp = await vaultFetch(
          `${baseUrl}/raw/${encodeURIComponent(collName)}/${encodeURIComponent("_meta.json")}`,
          {
            method: "PUT",
            body: meta,
            signal,
          },
        );

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              {
                type: "text" as const,
                text: `Collection create error (${resp.status}): ${errText}`,
              },
            ],
          };
        }

        // Trigger embedding
        vaultFetch(`${baseUrl}/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).catch(() => {});

        return {
          content: [
            {
              type: "text" as const,
              text: `Created agent collection "${collName}"${description ? ` — ${description}` : ""}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_agent_collection_write ------------------------------------------
  const vaultAgentCollectionWrite: AnyAgentTool = {
    name: "vault_agent_collection_write",
    label: "Write to Agent Collection",
    description:
      "Write or append content to an agent-managed collection. " +
      "Only works on collections created with vault_agent_collection_create. " +
      "Use this to add notes, files, or any content to a student/project/topic collection.",
    parameters: VaultAgentCollectionWriteSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const collName = String(params.collection || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const docPath = String(params.path || "").trim();
      const content = String(params.content ?? "");
      const append = Boolean(params.append);

      if (!collName) {
        return { content: [{ type: "text" as const, text: "Error: collection is required." }] };
      }
      if (!docPath) {
        return { content: [{ type: "text" as const, text: "Error: path is required." }] };
      }
      if (docPath === "_meta.json") {
        return {
          content: [
            { type: "text" as const, text: "Error: cannot write to _meta.json (reserved)." },
          ],
        };
      }
      if (!content) {
        return { content: [{ type: "text" as const, text: "Error: content is required." }] };
      }

      try {
        // Verify this is an agent collection
        const metaResp = await vaultFetch(
          `${baseUrl}/raw/${encodeURIComponent(collName)}/${encodeURIComponent("_meta.json")}`,
          {
            method: "GET",
            signal,
          },
        );
        if (!metaResp.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: "${collName}" is not an agent collection. Create it first with vault_agent_collection_create.`,
              },
            ],
          };
        }
        const metaText = await metaResp.text();
        try {
          const meta = JSON.parse(metaText);
          if (meta.source !== "agent") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: "${collName}" is not an agent collection (source: ${meta.source}).`,
                },
              ],
            };
          }
        } catch {
          return {
            content: [
              { type: "text" as const, text: `Error: "${collName}" has invalid _meta.json.` },
            ],
          };
        }

        // Write or append
        const encodedColl = encodeURIComponent(collName);
        const encodedPath = encodeURIComponent(docPath);
        let resp: Response;

        if (append) {
          resp = await vaultFetch(`${baseUrl}/raw/${encodedColl}/${encodedPath}/append`, {
            method: "POST",
            body: content,
            signal,
          });
        } else {
          resp = await vaultFetch(`${baseUrl}/raw/${encodedColl}/${encodedPath}`, {
            method: "PUT",
            body: content,
            signal,
          });
        }

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [{ type: "text" as const, text: `Write error (${resp.status}): ${errText}` }],
          };
        }

        // Trigger embedding
        vaultFetch(`${baseUrl}/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).catch(() => {});

        const action = append ? "appended to" : "wrote";
        return {
          content: [
            { type: "text" as const, text: `Successfully ${action} ${collName}/${docPath}` },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_collection_write ------------------------------------------------
  const vaultCollectionWrite: AnyAgentTool = {
    name: "vault_collection_write",
    label: "Write to Vault Collection",
    description:
      "Write or append content to any writable Vault collection path. " +
      "Use this for normal user collections like elevi, crm, or project registries. " +
      "For spreadsheet-backed files, prefer vault_spreadsheet_update instead.",
    parameters: VaultCollectionWriteSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const collName = String(params.collection || "").trim();
      const docPath = String(params.path || "").trim();
      const content = String(params.content ?? "");
      const append = Boolean(params.append);

      if (!collName) {
        return { content: [{ type: "text" as const, text: "Error: collection is required." }] };
      }
      if (!docPath) {
        return { content: [{ type: "text" as const, text: "Error: path is required." }] };
      }
      if (!content) {
        return { content: [{ type: "text" as const, text: "Error: content is required." }] };
      }

      try {
        const encodedColl = encodeURIComponent(collName);
        const encodedPath = encodeURIComponent(docPath);
        let resp: Response;

        if (append) {
          resp = await vaultFetch(`${baseUrl}/raw/${encodedColl}/${encodedPath}/append`, {
            method: "POST",
            body: content,
            signal,
          });
        } else {
          resp = await vaultFetch(`${baseUrl}/raw/${encodedColl}/${encodedPath}`, {
            method: "PUT",
            body: content,
            signal,
          });
        }

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [{ type: "text" as const, text: `Write error (${resp.status}): ${errText}` }],
          };
        }

        vaultFetch(`${baseUrl}/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).catch(() => {});

        const action = append ? "appended to" : "wrote";
        return {
          content: [
            { type: "text" as const, text: `Successfully ${action} ${collName}/${docPath}` },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_agent_collection_list -------------------------------------------
  const vaultAgentCollectionList: AnyAgentTool = {
    name: "vault_agent_collection_list",
    label: "List Agent Collections",
    description:
      "List all agent-managed collections in the vault. " +
      "Returns collection names, descriptions, and document counts. " +
      "Use this to discover existing agent collections before writing to them.",
    parameters: VaultAgentCollectionListSchema,
    async execute(_toolCallId: string, _params: Record<string, unknown>, signal?: AbortSignal) {
      try {
        // Get vault status to discover all collections
        const statusResp = await vaultFetch(`${baseUrl}/status`, {
          method: "GET",
          signal,
        });
        if (!statusResp.ok) {
          const errText = await statusResp.text();
          return {
            content: [
              { type: "text" as const, text: `Status error (${statusResp.status}): ${errText}` },
            ],
          };
        }

        const status = (await statusResp.json()) as {
          collections?: Array<{ name: string; documents?: number }>;
        };
        const collections = status.collections ?? [];

        // Check each collection for _meta.json with source:"agent"
        const agentCollections: Array<{ name: string; description: string; docs: number }> = [];

        for (const coll of collections) {
          if (coll.name.startsWith("_")) {
            continue; // Skip system collections
          }
          try {
            const metaResp = await vaultFetch(
              `${baseUrl}/raw/${encodeURIComponent(coll.name)}/${encodeURIComponent("_meta.json")}`,
              { method: "GET", signal },
            );
            if (!metaResp.ok) {
              continue;
            }
            const metaText = await metaResp.text();
            const meta = JSON.parse(metaText);
            if (meta.source === "agent") {
              agentCollections.push({
                name: coll.name,
                description: meta.description || "",
                docs: Math.max(0, (coll.documents ?? 1) - 1), // Subtract _meta.json
              });
            }
          } catch {
            continue;
          }
        }

        if (agentCollections.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No agent collections found. Create one with vault_agent_collection_create.",
              },
            ],
          };
        }

        const lines = agentCollections.map(
          (c) =>
            `• ${c.name} — ${c.description || "(no description)"} (${c.docs} doc${c.docs !== 1 ? "s" : ""})`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Agent collections (${agentCollections.length}):\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_artifact_write ----------------------------------------------------
  const vaultArtifactWrite: AnyAgentTool = {
    name: "vault_artifact_write",
    label: "Artifact Write",
    description:
      "Write content to the editable artifacts collection. Supports text files (JSON, markdown) and binary files (via base64 encoding). " +
      "Use this to store presentation specs, generated files, or other agent-produced artifacts. " +
      'When storing images for presentations or reports, use encoding "base64" with the correct mimeType, then reference that vault path from the spec.\n\n' +
      "Path conventions:\n" +
      "- presentations/<name>/spec.json for presentation specs\n" +
      "- reports/<name>/spec.json for report specs\n\n" +
      "Examples:\n" +
      '- path: "presentations/q1-report/spec.json", content: \'{"title":"Q1 Report",...}\', encoding: "utf8"\n' +
      '- path: "reports/board-memo/spec.json", content: \'{"title":"Board Memo",...}\', encoding: "utf8"\n' +
      '- path: "data/chart.png", content: "<base64>", encoding: "base64", mimeType: "image/png"',
    parameters: VaultArtifactWriteSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const path = normalizeEditableArtifactPath(String(params.path || ""));
      const content = String(params.content ?? "");
      const encoding = String(params.encoding || "utf8");
      const mimeType = params.mimeType ? String(params.mimeType) : undefined;

      if (!path) {
        return { content: [{ type: "text" as const, text: "Error: path is required." }] };
      }
      if (!content) {
        return { content: [{ type: "text" as const, text: "Error: content is required." }] };
      }

      try {
        const encodedPath = encodeURIComponent(path);
        if (encoding === "base64") {
          // Write binary artifacts through the raw endpoint; the vault stores them as binary blobs.
          const resp = await vaultFetch(`${baseUrl}/raw/_editable/${encodedPath}`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              ...(mimeType ? { "X-Mime-Type": mimeType } : {}),
            },
            body: Buffer.from(content, "base64"),
            signal,
          });
          if (!resp.ok) {
            const errText = await resp.text();
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Artifact write error (${resp.status}): ${errText}`,
                },
              ],
            };
          }
          const data = (await resp.json()) as { ok: boolean; hash?: string };
          return {
            content: [{ type: "text" as const, text: `Wrote editable/${path}` }],
            details: data,
          };
        }

        // Text content — write directly through raw endpoint
        const resp = await vaultFetch(`${baseUrl}/raw/_editable/${encodedPath}`, {
          method: "PUT",
          body: content,
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Artifact write error (${resp.status}): ${errText}` },
            ],
          };
        }

        const data = (await resp.json()) as { ok: boolean; hash?: string };
        return {
          content: [{ type: "text" as const, text: `Wrote editable/${path}` }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_artifact_list ----------------------------------------------------
  const vaultArtifactList: AnyAgentTool = {
    name: "vault_artifact_list",
    label: "Artifact List",
    description:
      "List artifacts in the editable collection, optionally filtered by path prefix. " +
      "Use this before adding presentation image slides to look for existing vault images you can reuse.\n\n" +
      "Examples:\n" +
      '- prefix: "presentations/" → list all presentations\n' +
      '- prefix: "presentations/q1-report/" → list files in a specific presentation\n' +
      "- omit prefix → list all artifacts",
    parameters: VaultArtifactListSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const prefix = normalizeEditableArtifactPath(String(params.prefix || ""));

      try {
        const url = prefix
          ? `${baseUrl}/artifacts?prefix=${encodeURIComponent(prefix)}`
          : `${baseUrl}/artifacts`;
        const resp = await vaultFetch(url, { signal });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Artifact list error (${resp.status}): ${errText}` },
            ],
          };
        }

        const data = (await resp.json()) as { items: ArtifactItem[] };
        const items = data.items || [];

        if (items.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: prefix
                  ? `No artifacts matching prefix: ${prefix}`
                  : "No artifacts in editable collection.",
              },
            ],
          };
        }

        const lines = items.map(
          (i) =>
            `  ${i.path} (${i.isBinary ? i.mimeType : "text"}, ${i.size} bytes, ${i.modifiedAt})`,
        );
        return {
          content: [
            { type: "text" as const, text: `Artifacts (${items.length}):\n${lines.join("\n")}` },
          ],
          details: { items },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_presentation_build ------------------------------------------------
  const vaultPresentationBuild: AnyAgentTool = {
    name: "vault_presentation_build",
    label: "Build Presentation",
    description:
      "Generate a PPTX file from a presentation spec stored in the editable collection. " +
      "The spec must exist at editable/presentations/<name>/spec.json. " +
      "The generated PPTX will be stored at editable/presentations/<name>/build/<name>.pptx.\n\n" +
      "Spec format: { title, subtitle?, author?, theme?: { primaryColor?, secondaryColor?, backgroundColor?, fontFace?, fontSize? }, " +
      'slides: [{ type: "title"|"bullets"|"two_col"|"image"|"table", title?, subtitle?, bullets?, left?, right?, image?, table?, notes? }] }\n\n' +
      'IMAGE SLIDES: For type "image", set image: { data, caption?, fit?: "contain"|"cover" }. ' +
      "Before using an image slide, first check vault_artifact_list for existing relevant images in the vault. " +
      "If none exist, use available image/web tools to generate or fetch an image, then store it with vault_artifact_write and reference that saved vault path. " +
      "Only fall back to a direct HTTPS image URL when you cannot persist the image first.\n" +
      "The data field MUST be one of:\n" +
      '  1. An HTTP/HTTPS URL (e.g. "https://images.unsplash.com/photo-xxx?w=1200") — the build endpoint will fetch it server-side\n' +
      '  2. A vault path written via vault_artifact_write (e.g. "presentations/deck/hero.png") — resolved from the editable collection\n' +
      '  3. A base64 data URI (e.g. "data:image/png;base64,...")\n' +
      'Do not create type "image" slides without a resolvable image.data value. ' +
      "If no usable image can be found or generated, use a bullets or two_col slide instead of leaving an image slide blank. " +
      "The build endpoint now fails when an image cannot be resolved into the PPTX.",
    parameters: VaultPresentationBuildSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const name = String(params.name || "");
      if (!name) {
        return { content: [{ type: "text" as const, text: "Error: name is required." }] };
      }

      try {
        const resp = await vaultFetch(`${baseUrl}/artifacts/build`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          let errorMsg: string;
          try {
            const errData = JSON.parse(errText);
            errorMsg = errData.error || errText;
          } catch {
            errorMsg = errText;
          }
          return {
            content: [{ type: "text" as const, text: `Build error (${resp.status}): ${errorMsg}` }],
          };
        }

        const data = (await resp.json()) as {
          ok: boolean;
          pptxPath?: string;
          size?: number;
          slides?: number;
          error?: string;
        };
        if (!data.ok) {
          return {
            content: [
              { type: "text" as const, text: `Build failed: ${data.error ?? "unknown error"}` },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Built presentation: editable/${data.pptxPath} (${data.size} bytes, ${data.slides} slides)`,
            },
          ],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  const vaultReportBuild: AnyAgentTool = {
    name: "vault_report_build",
    label: "Build Report",
    description:
      "Generate a polished PDF report from a report spec stored in the editable collection. " +
      "Use this for standalone written deliverables such as memos, summaries, research briefs, weekly updates, one-pagers, and analyses. " +
      "The spec must exist at editable/reports/<name>/spec.json. " +
      "The generated PDF will be stored at editable/reports/<name>/build/<name>.pdf.\n\n" +
      "Spec format: { title, subtitle?, author?, date?, summary?, closingNote?, hero?: { data, caption?, alt? }, " +
      "theme?: { accentColor?, accentSoftColor?, pageColor?, surfaceColor?, inkColor?, mutedColor?, headingFont?, bodyFont? }, " +
      "sections: [{ heading, kicker?, summary?, blocks: [" +
      '{ type: "paragraph", text }, ' +
      '{ type: "bullets", items: [...] }, ' +
      '{ type: "metrics", items: [{ label, value, note? }, ...] }, ' +
      '{ type: "quote", text, attribution? }, ' +
      '{ type: "table", caption?, headers: [...], rows: [[...], ...] }, ' +
      '{ type: "image", image: { data, caption?, alt? } }, ' +
      '{ type: "callout", tone?: "info"|"success"|"warning", title?, text }' +
      "] }] }\n\n" +
      "REPORT CONTENT ONLY: every text field in the spec should be document content relevant to the topic. " +
      "Do not include assistant framing or follow-up chatter like 'I made...', 'If you want, I can...', or 'Let me know...'. " +
      "Any optional next step belongs in the separate chat reply, not inside the report.\n\n" +
      "REPORT VISUALS: For image blocks and hero images, prefer relevant images already in the vault. " +
      "If none exist, use available image/web/browser tools to generate, capture, or fetch a visual, then store it with vault_artifact_write and reference that saved vault path. " +
      "The image data field may be an HTTP/HTTPS URL, a vault artifact path, or a base64 data URI. " +
      "Reports can include screenshots, charts, and other visuals as image blocks.",
    parameters: VaultReportBuildSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const name = String(params.name || "");
      if (!name) {
        return { content: [{ type: "text" as const, text: "Error: name is required." }] };
      }

      try {
        const resp = await vaultFetch(`${baseUrl}/reports/build`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          let errorMsg: string;
          try {
            const errData = JSON.parse(errText);
            errorMsg = errData.error || errText;
          } catch {
            errorMsg = errText;
          }
          return {
            content: [
              { type: "text" as const, text: `Report build error (${resp.status}): ${errorMsg}` },
            ],
          };
        }

        const data = (await resp.json()) as {
          ok: boolean;
          pdfPath?: string;
          size?: number;
          sections?: number;
          error?: string;
        };
        if (!data.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Report build failed: ${data.error ?? "unknown error"}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Built report: editable/${data.pdfPath} (${data.size} bytes, ${data.sections} sections)`,
            },
          ],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_artifact_url ------------------------------------------------------
  const vaultArtifactUrl: AnyAgentTool = {
    name: "vault_artifact_url",
    label: "Artifact URL",
    description:
      "Get a time-limited download URL for an artifact in the editable collection. " +
      "The URL is HMAC-signed and valid for 10 minutes. " +
      "To send this file via Telegram, include the URL on its own line prefixed with MEDIA: " +
      "(e.g. MEDIA:http://127.0.0.1:8181/artifacts/download?path=...&token=...). " +
      "The framework will automatically download the file and deliver it as a Telegram document.",
    parameters: VaultArtifactUrlSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const path = normalizeEditableArtifactPath(String(params.path || ""));
      if (!path) {
        return { content: [{ type: "text" as const, text: "Error: path is required." }] };
      }

      try {
        const resp = await vaultFetch(`${baseUrl}/artifacts/url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          let errorMsg: string;
          try {
            const errData = JSON.parse(errText);
            errorMsg = errData.error || errText;
          } catch {
            errorMsg = errText;
          }
          return {
            content: [
              { type: "text" as const, text: `Artifact URL error (${resp.status}): ${errorMsg}` },
            ],
          };
        }

        const data = (await resp.json()) as { url: string; expiresAtMs: number };
        return {
          content: [
            {
              type: "text" as const,
              text: `Download URL (10 min TTL) for editable/${path}:\nMEDIA:${data.url}\n\nExpires: ${new Date(data.expiresAtMs).toISOString()}`,
            },
          ],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_gmail_create_draft ------------------------------------------------
  const vaultGmailCreateDraft: AnyAgentTool = {
    name: "vault_gmail_create_draft",
    label: "Gmail Create Draft",
    description:
      "Create a Gmail draft email in the user's connected Gmail account. " +
      "The draft appears in Gmail's Drafts folder for the user to review and send. " +
      "For replies: use inReplyTo (the message_id from the vault email document), " +
      "references, and threadId (the thread_id from the vault email document) to thread the reply correctly. " +
      "Returns a Draft ID that can be used with vault_gmail_update_draft to revise the draft. " +
      "Only works when Gmail is connected with compose scope.",
    parameters: GmailCreateDraftSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const to = String(params.to || "").trim();
      const subject = String(params.subject || "").trim();
      const body = String(params.body || "");

      if (!to) {
        return {
          content: [{ type: "text" as const, text: "Error: 'to' (recipient email) is required." }],
        };
      }
      if (!subject) {
        return { content: [{ type: "text" as const, text: "Error: 'subject' is required." }] };
      }
      if (!body) {
        return { content: [{ type: "text" as const, text: "Error: 'body' is required." }] };
      }

      const payload: Record<string, unknown> = { to, subject, body };
      if (params.inReplyTo) payload.inReplyTo = String(params.inReplyTo);
      if (params.references) payload.references = String(params.references);
      if (params.threadId) payload.threadId = String(params.threadId);

      try {
        const resp = await vaultFetch(`${baseUrl}/connections/gmail/drafts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Gmail draft error (${resp.status}): ${errText}` },
            ],
          };
        }

        const data = (await resp.json()) as {
          id: string;
          message: { id: string; threadId: string };
        };

        const text =
          `Draft created successfully.\n` +
          `Draft ID: ${data.id}\n` +
          `To: ${to}\n` +
          `Subject: ${subject}\n` +
          `The draft is now in the user's Gmail Drafts folder, ready for review and sending.`;

        return {
          content: [{ type: "text" as const, text }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_gmail_update_draft ------------------------------------------------
  const vaultGmailUpdateDraft: AnyAgentTool = {
    name: "vault_gmail_update_draft",
    label: "Gmail Update Draft",
    description:
      "Update an existing Gmail draft. Replaces the draft's to, subject, and body. " +
      "Use the Draft ID returned by vault_gmail_create_draft. " +
      "Useful when the user wants to revise a draft before sending.",
    parameters: GmailUpdateDraftSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const draftId = String(params.draftId || "").trim();
      const to = String(params.to || "").trim();
      const subject = String(params.subject || "").trim();
      const body = String(params.body || "");

      if (!draftId) {
        return { content: [{ type: "text" as const, text: "Error: 'draftId' is required." }] };
      }
      if (!to) {
        return {
          content: [{ type: "text" as const, text: "Error: 'to' (recipient email) is required." }],
        };
      }
      if (!subject) {
        return { content: [{ type: "text" as const, text: "Error: 'subject' is required." }] };
      }
      if (!body) {
        return { content: [{ type: "text" as const, text: "Error: 'body' is required." }] };
      }

      const payload: Record<string, unknown> = { to, subject, body };
      if (params.inReplyTo) payload.inReplyTo = String(params.inReplyTo);
      if (params.references) payload.references = String(params.references);
      if (params.threadId) payload.threadId = String(params.threadId);

      try {
        const resp = await vaultFetch(
          `${baseUrl}/connections/gmail/drafts/${encodeURIComponent(draftId)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal,
          },
        );

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              {
                type: "text" as const,
                text: `Gmail draft update error (${resp.status}): ${errText}`,
              },
            ],
          };
        }

        const data = (await resp.json()) as {
          id: string;
          message: { id: string; threadId: string };
        };

        const text =
          `Draft updated successfully.\n` +
          `Draft ID: ${data.id}\n` +
          `To: ${to}\n` +
          `Subject: ${subject}\n` +
          `The updated draft is in the user's Gmail Drafts folder.`;

        return {
          content: [{ type: "text" as const, text }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_github_create_issue -----------------------------------------------
  const vaultGitHubCreateIssue: AnyAgentTool = {
    name: "vault_github_create_issue",
    label: "GitHub Create Issue",
    description:
      "Create a GitHub issue on a connected repository. " +
      "Returns the issue number and URL. Only works when GitHub is connected.",
    parameters: GitHubCreateIssueSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const owner = String(params.owner || "").trim();
      const repo = String(params.repo || "").trim();
      const title = String(params.title || "").trim();
      if (!owner || !repo || !title) {
        return {
          content: [{ type: "text" as const, text: "Error: owner, repo, and title are required." }],
        };
      }
      const payload: Record<string, unknown> = { owner, repo, title };
      if (params.body) payload.body = String(params.body);
      if (Array.isArray(params.labels)) payload.labels = params.labels;
      try {
        const resp = await vaultFetch(`${baseUrl}/connections/github/issues`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `GitHub issue error (${resp.status}): ${errText}` },
            ],
          };
        }
        const data = (await resp.json()) as { number: number; title: string; htmlUrl: string };
        return {
          content: [
            {
              type: "text" as const,
              text: `Issue created: #${data.number} — ${data.title}\n${data.htmlUrl}`,
            },
          ],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_github_list_issues ------------------------------------------------
  const vaultGitHubListIssues: AnyAgentTool = {
    name: "vault_github_list_issues",
    label: "GitHub List Issues",
    description:
      "List issues on a connected GitHub repository. Returns issue numbers, titles, state, and labels.",
    parameters: GitHubListIssuesSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const owner = String(params.owner || "").trim();
      const repo = String(params.repo || "").trim();
      const state = String(params.state || "open");
      if (!owner || !repo) {
        return {
          content: [{ type: "text" as const, text: "Error: owner and repo are required." }],
        };
      }
      try {
        const resp = await vaultFetch(
          `${baseUrl}/connections/github/issues?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&state=${state}`,
          { signal },
        );
        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `GitHub issues error (${resp.status}): ${errText}` },
            ],
          };
        }
        const issues = (await resp.json()) as Array<{
          number: number;
          title: string;
          state: string;
          labels: string[];
          user: string;
          htmlUrl: string;
        }>;
        if (!issues.length) {
          return {
            content: [
              { type: "text" as const, text: `No ${state} issues found in ${owner}/${repo}.` },
            ],
          };
        }
        const lines = issues.map(
          (i) =>
            `#${i.number} [${i.state}] ${i.title}${i.labels.length ? ` (${i.labels.join(", ")})` : ""}`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${issues.length} issues in ${owner}/${repo}:\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_github_create_branch ----------------------------------------------
  const vaultGitHubCreateBranch: AnyAgentTool = {
    name: "vault_github_create_branch",
    label: "GitHub Create Branch",
    description:
      "Create a new branch on a connected GitHub repository. " +
      "Defaults to branching from the repo's default branch if 'from' is not specified.",
    parameters: GitHubCreateBranchSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const owner = String(params.owner || "").trim();
      const repo = String(params.repo || "").trim();
      const branch = String(params.branch || "").trim();
      if (!owner || !repo || !branch) {
        return {
          content: [
            { type: "text" as const, text: "Error: owner, repo, and branch are required." },
          ],
        };
      }
      const payload: Record<string, unknown> = { owner, repo, branch };
      if (params.from) payload.from = String(params.from);
      try {
        const resp = await vaultFetch(`${baseUrl}/connections/github/branches`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `GitHub branch error (${resp.status}): ${errText}` },
            ],
          };
        }
        const data = (await resp.json()) as { ref: string; sha: string };
        return {
          content: [
            {
              type: "text" as const,
              text: `Branch created: ${branch}\nRef: ${data.ref}\nSHA: ${data.sha.slice(0, 7)}`,
            },
          ],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_github_create_pr --------------------------------------------------
  const vaultGitHubCreatePR: AnyAgentTool = {
    name: "vault_github_create_pr",
    label: "GitHub Create PR",
    description:
      "Create a pull request on a connected GitHub repository. " +
      "Specify the head (source) branch. Base defaults to the repo's default branch. " +
      "NOTE: You cannot merge PRs — only a human can do that.",
    parameters: GitHubCreatePRSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const owner = String(params.owner || "").trim();
      const repo = String(params.repo || "").trim();
      const title = String(params.title || "").trim();
      const head = String(params.head || "").trim();
      if (!owner || !repo || !title || !head) {
        return {
          content: [
            { type: "text" as const, text: "Error: owner, repo, title, and head are required." },
          ],
        };
      }
      const payload: Record<string, unknown> = { owner, repo, title, head };
      if (params.body) payload.body = String(params.body);
      if (params.base) payload.base = String(params.base);
      try {
        const resp = await vaultFetch(`${baseUrl}/connections/github/pull-requests`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `GitHub PR error (${resp.status}): ${errText}` },
            ],
          };
        }
        const data = (await resp.json()) as {
          number: number;
          title: string;
          htmlUrl: string;
          head: string;
          base: string;
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `PR created: #${data.number} — ${data.title}\n${data.head} → ${data.base}\n${data.htmlUrl}`,
            },
          ],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_github_list_prs ---------------------------------------------------
  const vaultGitHubListPRs: AnyAgentTool = {
    name: "vault_github_list_prs",
    label: "GitHub List PRs",
    description: "List pull requests on a connected GitHub repository.",
    parameters: GitHubListPRsSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const owner = String(params.owner || "").trim();
      const repo = String(params.repo || "").trim();
      const state = String(params.state || "open");
      if (!owner || !repo) {
        return {
          content: [{ type: "text" as const, text: "Error: owner and repo are required." }],
        };
      }
      try {
        const resp = await vaultFetch(
          `${baseUrl}/connections/github/pull-requests?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&state=${state}`,
          { signal },
        );
        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `GitHub PRs error (${resp.status}): ${errText}` },
            ],
          };
        }
        const prs = (await resp.json()) as Array<{
          number: number;
          title: string;
          state: string;
          head: string;
          base: string;
          htmlUrl: string;
        }>;
        if (!prs.length) {
          return {
            content: [
              { type: "text" as const, text: `No ${state} pull requests in ${owner}/${repo}.` },
            ],
          };
        }
        const lines = prs.map(
          (p) => `#${p.number} [${p.state}] ${p.title} (${p.head} → ${p.base})`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${prs.length} PRs in ${owner}/${repo}:\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_github_push -------------------------------------------------------
  const vaultGitHubPush: AnyAgentTool = {
    name: "vault_github_push",
    label: "GitHub Push",
    description:
      "Push file changes to a branch on a connected GitHub repository via the Git Data API. " +
      "CANNOT push to main, master, or the repo's default branch — create a feature branch first. " +
      "Creates a commit with the specified files and message.",
    parameters: GitHubPushSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const owner = String(params.owner || "").trim();
      const repo = String(params.repo || "").trim();
      const branch = String(params.branch || "").trim();
      const message = String(params.message || "").trim();
      const files = params.files as Array<{ path: string; content: string }> | undefined;
      if (!owner || !repo || !branch || !message || !files?.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: owner, repo, branch, files, and message are required.",
            },
          ],
        };
      }
      // Client-side safety check
      if (branch === "main" || branch === "master") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Refused: cannot push to protected branch "${branch}". Create a feature branch first.`,
            },
          ],
        };
      }
      try {
        const resp = await vaultFetch(`${baseUrl}/connections/github/push`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner, repo, branch, files, message }),
          signal,
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `GitHub push error (${resp.status}): ${errText}` },
            ],
          };
        }
        const data = (await resp.json()) as { sha: string };
        return {
          content: [
            {
              type: "text" as const,
              text: `Pushed ${files.length} file(s) to ${owner}/${repo}:${branch}\nCommit: ${data.sha.slice(0, 7)}\nMessage: ${message}`,
            },
          ],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_repos_list --------------------------------------------------------
  const vaultReposList: AnyAgentTool = {
    name: "vault_repos_list",
    label: "List Repos",
    description:
      "List all repositories available on disk in the shared repos directory (~/.straja/repos/). " +
      "Returns repo names, paths, and whether they have a .git directory. " +
      "Use this to discover which repos you can work with via vault_exec.",
    parameters: ReposListSchema,
    async execute(_toolCallId: string, _params: Record<string, unknown>, signal?: AbortSignal) {
      try {
        const resp = await vaultFetch(`${baseUrl}/repos`, { signal });
        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Repos list error (${resp.status}): ${errText}` },
            ],
          };
        }
        const data = (await resp.json()) as {
          repos: Array<{ name: string; path: string; hasGit: boolean }>;
          baseDir: string;
        };
        if (!data.repos.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No repos found in ${data.baseDir}. Connect GitHub repos via the vault UI to clone them here.`,
              },
            ],
          };
        }
        const lines = data.repos.map((r) => `${r.name}${r.hasGit ? " (git)" : ""}  →  ${r.path}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `${data.repos.length} repo(s) in ${data.baseDir}:\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_repo_exec ---------------------------------------------------------
  const vaultRepoExec: AnyAgentTool = {
    name: "vault_repo_exec",
    label: "Repo Execute",
    description:
      "Execute a command in a sandboxed environment scoped to on-disk repos (~/.straja/repos/). " +
      "Has real filesystem access with git, build tools, package managers, etc. " +
      "Network access is domain-filtered (GitHub, npm registry, and configured allowlist). " +
      "Use vault_repos_list to discover available repos first. " +
      "This is for software/code repos only. Do NOT use it to search the user's Vault documents, collections, notes, spreadsheets, or student records. " +
      "For user knowledge retrieval, use vault_search and vault_get instead. " +
      "The cwd parameter is required and must be a repo name or path within a repo. " +
      "Commands that complete within 5 seconds return results immediately. " +
      "Longer-running commands are automatically backgrounded — " +
      "use vault_process to poll output, write stdin, or kill the process.",
    parameters: RepoExecSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const command = String(params.command || "");
      if (!command) {
        return {
          content: [{ type: "text" as const, text: "Error: command is required." }],
        };
      }
      const cwd = String(params.cwd || "").trim();
      if (!cwd) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: cwd is required (repo name, e.g. 'my-repo' or 'my-repo/src').",
            },
          ],
        };
      }

      const payload: Record<string, unknown> = {
        command,
        args: (params.args as string[]) ?? [],
        timeout: (params.timeout as number) ?? 30,
        cwd,
      };
      if (params.background === true) {
        payload.background = true;
      }
      if (typeof params.yieldMs === "number") {
        payload.yieldMs = params.yieldMs;
      } else if (params.background !== true) {
        payload.yieldMs = 5000;
      }

      try {
        const resp = await vaultFetch(`${baseUrl}/repo-exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              { type: "text" as const, text: `Repo exec error (${resp.status}): ${errText}` },
            ],
          };
        }

        const data = (await resp.json()) as Record<string, unknown>;

        // Background mode — still running after yield window
        if (data.status === "running" && !data.output) {
          const text =
            `Command running in background.\n` +
            `Session ID: ${data.sessionId}\n` +
            `PID: ${data.pid}\n` +
            `Use vault_process to interact (poll, log, write, kill, clear, remove).`;
          return {
            content: [{ type: "text" as const, text }],
            details: data,
          };
        }

        // Completed or yielded with partial output
        const parts: string[] = [];
        if (data.timedOut) {
          parts.push("⚠ Command timed out and was killed.");
        }
        if (data.status === "running") {
          parts.push(`Command still running (session: ${data.sessionId}). Partial output below.`);
          parts.push(`Use vault_process to get remaining output.`);
        }
        parts.push(`Exit code: ${data.exitCode ?? "pending"}`);
        // Yield mode returns output/tail; sync mode returns stdout/stderr
        const stdout = String(data.stdout || data.output || "").trim();
        const stderr = String(data.stderr || "").trim();
        if (stdout) parts.push(`\nStdout:\n${stdout}`);
        if (stderr) parts.push(`\nStderr:\n${stderr}`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_gcalendar_create_event -------------------------------------------
  const vaultCalendarCreateEvent: AnyAgentTool = {
    name: "vault_gcalendar_create_event",
    label: "Calendar Create Event",
    description:
      "Create a new event on the user's Google Calendar. " +
      "Specify start/end as ISO 8601 datetime for timed events, or date-only (YYYY-MM-DD) for all-day events. " +
      "Returns the created event ID and link. Only works when Google Calendar is connected.",
    parameters: CalendarCreateEventSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const summary = String(params.summary || "").trim();
      const start = String(params.start || "").trim();
      const end = String(params.end || "").trim();

      if (!summary) {
        return {
          content: [{ type: "text" as const, text: "Error: 'summary' (event title) is required." }],
        };
      }
      if (!start || !end) {
        return {
          content: [{ type: "text" as const, text: "Error: 'start' and 'end' are required." }],
        };
      }

      const payload: Record<string, unknown> = {
        calendarId: String(params.calendarId || "primary"),
        summary,
        start,
        end,
      };
      if (params.description) payload.description = String(params.description);
      if (params.location) payload.location = String(params.location);
      if (params.timeZone) payload.timeZone = String(params.timeZone);
      if (Array.isArray(params.attendees)) payload.attendees = params.attendees;

      try {
        const resp = await vaultFetch(`${baseUrl}/connections/gcalendar/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              {
                type: "text" as const,
                text: `Calendar event creation error (${resp.status}): ${errText}`,
              },
            ],
          };
        }

        const data = (await resp.json()) as {
          id: string;
          calendarId: string;
          htmlLink?: string;
          summary: string;
          start: string;
          end: string;
        };

        const text =
          `Event created successfully.\n` +
          `Event ID: ${data.id}\n` +
          `Title: ${data.summary}\n` +
          `Start: ${data.start}\n` +
          `End: ${data.end}\n` +
          (data.htmlLink ? `Link: ${data.htmlLink}\n` : "");

        return {
          content: [{ type: "text" as const, text }],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_gcalendar_update_event -------------------------------------------
  const vaultCalendarUpdateEvent: AnyAgentTool = {
    name: "vault_gcalendar_update_event",
    label: "Calendar Update Event",
    description:
      "Update an existing Google Calendar event. Use the event_id from vault calendar documents. " +
      "Only include the fields you want to change.",
    parameters: CalendarUpdateEventSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const eventId = String(params.eventId || "").trim();
      if (!eventId) {
        return { content: [{ type: "text" as const, text: "Error: 'eventId' is required." }] };
      }

      const payload: Record<string, unknown> = {
        calendarId: String(params.calendarId || "primary"),
      };
      if (params.summary !== undefined) payload.summary = String(params.summary);
      if (params.description !== undefined) payload.description = String(params.description);
      if (params.start !== undefined) payload.start = String(params.start);
      if (params.end !== undefined) payload.end = String(params.end);
      if (params.location !== undefined) payload.location = String(params.location);
      if (params.timeZone !== undefined) payload.timeZone = String(params.timeZone);
      if (Array.isArray(params.attendees)) payload.attendees = params.attendees;

      try {
        const resp = await vaultFetch(
          `${baseUrl}/connections/gcalendar/events/${encodeURIComponent(eventId)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal,
          },
        );

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              {
                type: "text" as const,
                text: `Calendar event update error (${resp.status}): ${errText}`,
              },
            ],
          };
        }

        const data = (await resp.json()) as {
          id: string;
          calendarId: string;
          htmlLink?: string;
          summary: string;
          start: string;
          end: string;
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `Event updated successfully.\nEvent ID: ${data.id}\nTitle: ${data.summary}`,
            },
          ],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // -- vault_gcalendar_delete_event -------------------------------------------
  const vaultCalendarDeleteEvent: AnyAgentTool = {
    name: "vault_gcalendar_delete_event",
    label: "Calendar Delete Event",
    description:
      "Delete an event from Google Calendar. Use the event_id from vault calendar documents. " +
      "This permanently removes the event from the calendar.",
    parameters: CalendarDeleteEventSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const eventId = String(params.eventId || "").trim();
      if (!eventId) {
        return { content: [{ type: "text" as const, text: "Error: 'eventId' is required." }] };
      }

      const calendarId = String(params.calendarId || "primary");

      try {
        const resp = await vaultFetch(
          `${baseUrl}/connections/gcalendar/events/${encodeURIComponent(eventId)}?calendarId=${encodeURIComponent(calendarId)}`,
          {
            method: "DELETE",
            signal,
          },
        );

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              {
                type: "text" as const,
                text: `Calendar event deletion error (${resp.status}): ${errText}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Event ${eventId} deleted successfully from calendar ${calendarId}.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  const vaultWebSearchDuckDuckGo: AnyAgentTool = {
    name: "vault_web_search_duckduckgo",
    label: "DuckDuckGo Search",
    description:
      "Search the public web with DuckDuckGo through the vault. " +
      "This is the default tool for ordinary factual web lookups when vault content is insufficient and you need current public web results. " +
      "Prefer this over browser tools for simple questions, rankings, dates, medal tables, definitions, and quick comparisons. " +
      "The vault records these searches in an immutable audit log shown in the Web tab.",
    parameters: VaultWebSearchDuckDuckGoSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const query = String(params.query || "");
      if (!query.trim()) {
        return { content: [{ type: "text" as const, text: "Error: query is required." }] };
      }

      try {
        const resp = await vaultFetch(`${baseUrl}/connections/web-search/duckduckgo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            limit: typeof params.limit === "number" ? params.limit : undefined,
          }),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          let errorMsg: string;
          try {
            const errData = JSON.parse(errText);
            errorMsg = errData.error || errText;
          } catch {
            errorMsg = errText;
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `DuckDuckGo search error (${resp.status}): ${errorMsg}`,
              },
            ],
          };
        }

        const data = (await resp.json()) as {
          provider: "duckduckgo";
          query: string;
          results: Array<{ title: string; url: string; snippet?: string | null }>;
        };

        if (!Array.isArray(data.results) || data.results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `DuckDuckGo returned no results for "${data.query}".`,
              },
            ],
            details: data,
          };
        }

        const summary = data.results
          .map((item, index) => {
            const lines = [`${index + 1}. ${item.title}`, `   ${item.url}`];
            if (item.snippet) lines.push(`   ${item.snippet}`);
            return lines.join("\n");
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `DuckDuckGo results for "${data.query}":\n\n${summary}`,
            },
          ],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Web Fetch — proxy to vault's web-fetch endpoint
  // ---------------------------------------------------------------------------

  const vaultWebFetch: AnyAgentTool = {
    name: "vault_web_fetch",
    label: "Web Fetch",
    description:
      "Fetch and extract readable content from a URL (HTML → markdown/text) through the vault. " +
      "Use for lightweight page access without browser automation. " +
      "Prefer this over browser tools for reading articles, documentation, API responses, and public web pages. " +
      "Falls back to simple HTML extraction when full article parsing is unavailable.",
    parameters: VaultWebFetchSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const url = String(params.url || "");
      if (!url.trim()) {
        return { content: [{ type: "text" as const, text: "Error: url is required." }] };
      }

      try {
        const resp = await vaultFetch(`${baseUrl}/connections/web-fetch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url,
            extractMode: typeof params.extractMode === "string" ? params.extractMode : undefined,
            maxChars: typeof params.maxChars === "number" ? params.maxChars : undefined,
          }),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          let errorMsg: string;
          try {
            const errData = JSON.parse(errText);
            errorMsg = errData.error || errText;
          } catch {
            errorMsg = errText;
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `Web fetch error (${resp.status}): ${errorMsg}`,
              },
            ],
          };
        }

        const data = (await resp.json()) as {
          url: string;
          finalUrl: string;
          status: number;
          contentType: string;
          title?: string;
          extractMode: string;
          extractor: string;
          truncated: boolean;
          length: number;
          fetchedAt: string;
          tookMs: number;
          text: string;
          cached?: boolean;
        };

        const header = data.title
          ? `# ${data.title}\n\nSource: ${data.finalUrl}\n\n`
          : `Source: ${data.finalUrl}\n\n`;

        return {
          content: [
            {
              type: "text" as const,
              text: `${header}${data.text}`,
            },
          ],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Domain Approval — approve a blocked domain for web-fetch / browser
  // ---------------------------------------------------------------------------

  const vaultApproveDomain: AnyAgentTool = {
    name: "vault_approve_domain",
    label: "Approve Domain",
    description:
      "Manage domain access for web-fetch, browser navigation, and form submissions. " +
      "Call with 'once' or 'always' when a fetch, navigation, or form submit is blocked and the user approves. " +
      'Call with "remove" to revoke. Use capability "navigate" (default) for domain allowlist, "post" for form submissions, or "all" for both. ' +
      "After approval, retry the original action — it will succeed.",
    parameters: VaultApproveDomainSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const domain = String(params.domain || "")
        .trim()
        .toLowerCase();
      if (!domain) {
        return { content: [{ type: "text" as const, text: "Error: domain is required." }] };
      }

      const decision = String(params.decision || "");
      if (decision !== "once" && decision !== "always" && decision !== "remove") {
        return {
          content: [
            {
              type: "text" as const,
              text: 'Error: decision must be "once", "always", or "remove".',
            },
          ],
        };
      }

      const scope = String(params.scope || "all");
      const capability = String(params.capability || "navigate");

      try {
        const resp = await vaultFetch(`${baseUrl}/connections/approve-domain`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain, decision, scope, capability }),
          signal,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return {
            content: [
              {
                type: "text" as const,
                text: `Domain approval error (${resp.status}): ${errText}`,
              },
            ],
          };
        }

        const data = (await resp.json()) as {
          ok: boolean;
          domain: string;
          decision: string;
          message: string;
        };

        return {
          content: [
            {
              type: "text" as const,
              text: data.message || `Domain ${domain} approved (${decision}).`,
            },
          ],
          details: data,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Vault connection error: ${String(err)}` }],
        };
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Browser tools — proxy to vault's playwright-mcp browser service
  // ---------------------------------------------------------------------------

  const browserUsageNote =
    "Use browser tools only for interactive or fallback web work: login/auth flows, forms, clicks, multi-step navigation, JS-rendered pages, screenshots, or downloads. " +
    "Do not use them as a general search-engine path when vault_web_search_duckduckgo can answer the question.";

  /** Helper: call a vault browser tool via the HTTP proxy endpoint */
  async function callBrowserTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    content: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>;
  }> {
    try {
      const resp = await vaultFetch(`${baseUrl}/connections/browser/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: toolName, arguments: args }),
        signal,
      });
      if (!resp.ok) {
        const errText = await resp.text();
        return {
          content: [{ type: "text" as const, text: `Browser error (${resp.status}): ${errText}` }],
        };
      }
      const data = await resp.json();
      return data as any;
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Browser connection error: ${String(err)}` }],
      };
    }
  }

  async function callBrowserConnection(
    path: string,
    method: "GET" | "POST",
    body: Record<string, unknown> | null,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }> {
    try {
      const resp = await vaultFetch(`${baseUrl}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      const raw = await resp.text();
      let parsed: unknown = raw;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        // leave as raw text
      }
      if (!resp.ok) {
        const errorText =
          parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)
            ? String((parsed as Record<string, unknown>).error)
            : String(raw || `HTTP ${resp.status}`);
        return {
          content: [
            { type: "text" as const, text: `Browser error (${resp.status}): ${errorText}` },
          ],
          details: parsed,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2),
          },
        ],
        details: parsed,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Browser connection error: ${String(err)}` }],
      };
    }
  }

  const vaultBrowserNavigate: AnyAgentTool = {
    name: "vault_browser_navigate",
    label: "Browser Navigate",
    description: `Navigate the vault browser to a URL. ${browserUsageNote}`,
    parameters: BrowserNavigateSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_navigate", params, signal);
    },
  };

  const vaultBrowserSnapshot: AnyAgentTool = {
    name: "vault_browser_snapshot",
    label: "Browser Snapshot",
    description:
      "Get an accessibility tree snapshot of the current page. " +
      "Returns a structured text representation of all page elements with references " +
      `you can use in click/type/fill actions. ${browserUsageNote}`,
    parameters: BrowserSnapshotSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_snapshot", params, signal);
    },
  };

  const vaultBrowserClick: AnyAgentTool = {
    name: "vault_browser_click",
    label: "Browser Click",
    description: `Click an element on the page. Use 'ref' from a snapshot for precision, or describe the element. ${browserUsageNote}`,
    parameters: BrowserClickSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_click", params, signal);
    },
  };

  const vaultBrowserType: AnyAgentTool = {
    name: "vault_browser_type",
    label: "Browser Type",
    description: `Type text into an editable element. Set submit: true to press Enter after typing. ${browserUsageNote}`,
    parameters: BrowserTypeSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_type", params, signal);
    },
  };

  const vaultBrowserFill: AnyAgentTool = {
    name: "vault_browser_fill",
    label: "Browser Fill",
    description: `Clear a form field and fill it with a new value. ${browserUsageNote}`,
    parameters: BrowserFillSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_fill", params, signal);
    },
  };

  const vaultBrowserSelect: AnyAgentTool = {
    name: "vault_browser_select",
    label: "Browser Select",
    description: `Select an option from a dropdown/select element. ${browserUsageNote}`,
    parameters: BrowserSelectSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_select_option", params, signal);
    },
  };

  const vaultBrowserHover: AnyAgentTool = {
    name: "vault_browser_hover",
    label: "Browser Hover",
    description: `Hover over an element to reveal tooltips or dropdown menus. ${browserUsageNote}`,
    parameters: BrowserHoverSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_hover", params, signal);
    },
  };

  const vaultBrowserPressKey: AnyAgentTool = {
    name: "vault_browser_press_key",
    label: "Browser Press Key",
    description: `Press a keyboard key or combination (e.g. Enter, Escape, Control+c, Tab). ${browserUsageNote}`,
    parameters: BrowserPressKeySchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_press_key", params, signal);
    },
  };

  const vaultBrowserScreenshot: AnyAgentTool = {
    name: "vault_browser_screenshot",
    label: "Browser Screenshot",
    description: `Take a screenshot of the current page. Returns a base64 PNG image. ${browserUsageNote}`,
    parameters: BrowserScreenshotSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_take_screenshot", params, signal);
    },
  };

  const vaultBrowserTabList: AnyAgentTool = {
    name: "vault_browser_tab_list",
    label: "Browser Tab List",
    description: `List all open browser tabs with their URLs and titles. ${browserUsageNote}`,
    parameters: BrowserTabListSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_tab_list", params, signal);
    },
  };

  const vaultBrowserTabNew: AnyAgentTool = {
    name: "vault_browser_tab_new",
    label: "Browser New Tab",
    description: `Open a new browser tab, optionally navigating to a URL. ${browserUsageNote}`,
    parameters: BrowserTabNewSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_tab_new", params, signal);
    },
  };

  const vaultBrowserTabClose: AnyAgentTool = {
    name: "vault_browser_tab_close",
    label: "Browser Close Tab",
    description: `Close a browser tab by index. ${browserUsageNote}`,
    parameters: BrowserTabCloseSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_tab_close", params, signal);
    },
  };

  const vaultBrowserTabs: AnyAgentTool = {
    name: "vault_browser_tabs",
    label: "Browser Tabs",
    description: `Manage tabs (list, new, close, select). ${browserUsageNote}`,
    parameters: BrowserTabsSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_tabs", params, signal);
    },
  };

  const vaultBrowserPdf: AnyAgentTool = {
    name: "vault_browser_pdf",
    label: "Browser Save PDF",
    description: `Save the current page as a PDF. ${browserUsageNote}`,
    parameters: BrowserPdfSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_pdf_save", params, signal);
    },
  };

  const vaultBrowserDialog: AnyAgentTool = {
    name: "vault_browser_dialog",
    label: "Browser Dialog",
    description: `Accept or dismiss an active browser dialog. ${browserUsageNote}`,
    parameters: BrowserDialogSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_handle_dialog", params, signal);
    },
  };

  const vaultBrowserUpload: AnyAgentTool = {
    name: "vault_browser_upload",
    label: "Browser Upload",
    description:
      "Upload a file from the vault to an active browser file chooser. " +
      "Uses vault collections only (no host filesystem paths). Can also auto-stage vault /media URLs into '_uploads'.",
    parameters: BrowserUploadSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserConnection("/connections/browser/upload", "POST", params, signal);
    },
  };

  const vaultStageMediaUpload: AnyAgentTool = {
    name: "vault_stage_media_upload",
    label: "Stage Media Upload",
    description:
      "Stage inbound vault media (such as a Telegram photo stored under /media) into '_uploads' so it can be used with vault_browser_upload.",
    parameters: BrowserStageMediaUploadSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserConnection(
        "/connections/browser/uploads/stage-from-media",
        "POST",
        params,
        signal,
      );
    },
  };

  const vaultBrowserStatus: AnyAgentTool = {
    name: "vault_browser_status",
    label: "Browser Status",
    description: "Get browser service status (running/stopped/configuration summary).",
    parameters: BrowserStatusSchema,
    async execute(_id: string, _params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserConnection("/connections/browser/status", "GET", null, signal);
    },
  };

  const vaultBrowserStart: AnyAgentTool = {
    name: "vault_browser_start",
    label: "Browser Start",
    description: "Start the vault browser service using saved browser config.",
    parameters: BrowserStartSchema,
    async execute(_id: string, _params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserConnection("/connections/browser/start", "POST", {}, signal);
    },
  };

  const vaultBrowserStop: AnyAgentTool = {
    name: "vault_browser_stop",
    label: "Browser Stop",
    description: "Stop the vault browser service.",
    parameters: BrowserStopSchema,
    async execute(_id: string, _params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserConnection("/connections/browser/stop", "POST", {}, signal);
    },
  };

  const vaultBrowserConsole: AnyAgentTool = {
    name: "vault_browser_console",
    label: "Browser Console",
    description: `Get browser console messages (log, warn, error). ${browserUsageNote}`,
    parameters: BrowserConsoleSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_console_messages", params, signal);
    },
  };

  const vaultBrowserWait: AnyAgentTool = {
    name: "vault_browser_wait",
    label: "Browser Wait",
    description: `Wait for specific text to appear or disappear on the page. ${browserUsageNote}`,
    parameters: BrowserWaitSchema,
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return callBrowserTool("browser_wait_for", params, signal);
    },
  };

  return [
    vaultSearch,
    vaultGet,
    vaultSpreadsheetGet,
    vaultSpreadsheetMatch,
    vaultSpreadsheetUpdate,
    vaultStatus,
    vaultExec,
    vaultProcess,
    vaultMemorySearch,
    vaultMemoryGet,
    vaultMemoryWrite,
    vaultNoteCreate,
    vaultNoteUpdate,
    vaultAgentCollectionCreate,
    vaultAgentCollectionWrite,
    vaultCollectionWrite,
    vaultAgentCollectionList,
    vaultArtifactWrite,
    vaultArtifactList,
    vaultPresentationBuild,
    vaultReportBuild,
    vaultArtifactUrl,
    vaultWebSearchDuckDuckGo,
    vaultWebFetch,
    vaultApproveDomain,
    vaultGmailCreateDraft,
    vaultGmailUpdateDraft,
    vaultGitHubCreateIssue,
    vaultGitHubListIssues,
    vaultGitHubCreateBranch,
    vaultGitHubCreatePR,
    vaultGitHubListPRs,
    vaultGitHubPush,
    vaultReposList,
    vaultRepoExec,
    vaultCalendarCreateEvent,
    vaultCalendarUpdateEvent,
    vaultCalendarDeleteEvent,
    vaultBrowserNavigate,
    vaultBrowserSnapshot,
    vaultBrowserClick,
    vaultBrowserType,
    vaultBrowserFill,
    vaultBrowserSelect,
    vaultBrowserHover,
    vaultBrowserPressKey,
    vaultBrowserScreenshot,
    vaultBrowserTabList,
    vaultBrowserTabNew,
    vaultBrowserTabClose,
    vaultBrowserTabs,
    vaultBrowserPdf,
    vaultBrowserDialog,
    vaultStageMediaUpload,
    vaultBrowserUpload,
    vaultBrowserStatus,
    vaultBrowserStart,
    vaultBrowserStop,
    vaultBrowserConsole,
    vaultBrowserWait,
  ].map(withFlowTestRecording);
}
