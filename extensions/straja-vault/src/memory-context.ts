export type VaultMemoryFileEntry = {
  path: string;
  modifiedAt?: string;
};

export type RecentMemoryEntry = {
  path: string;
  content: string;
};

const DAILY_MEMORY_PATH_RE = /^memory\/(\d{4}-\d{2}-\d{2})\.md$/;
const MAX_MEMORY_CONTEXT_CHARS = 6_000;

export function isDailyMemoryPath(filePath: string): boolean {
  return DAILY_MEMORY_PATH_RE.test(filePath.trim());
}

function dailyMemorySortKey(entry: VaultMemoryFileEntry): string {
  const match = DAILY_MEMORY_PATH_RE.exec(entry.path.trim());
  if (match?.[1]) {
    return match[1];
  }
  return entry.modifiedAt?.trim() || "";
}

export function selectRecentDailyMemoryPaths(files: VaultMemoryFileEntry[], limit = 2): string[] {
  return files
    .filter((entry) => isDailyMemoryPath(entry.path))
    .sort((a, b) => dailyMemorySortKey(b).localeCompare(dailyMemorySortKey(a)))
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.path);
}

function trimForPrompt(content: string): string {
  const normalized = content.trim();
  if (normalized.length <= MAX_MEMORY_CONTEXT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_MEMORY_CONTEXT_CHARS)}\n\n[truncated for prompt]`;
}

export function formatPersistentMemoryContext(params: {
  memoryContent?: string | null;
  recentDaily: RecentMemoryEntry[];
}): string | null {
  const sections: string[] = [];

  if (params.memoryContent?.trim()) {
    sections.push("## Long-Term Memory\n" + trimForPrompt(params.memoryContent));
  }

  const recentDaily = params.recentDaily.filter(
    (entry) => entry.path.trim() && entry.content.trim(),
  );
  if (recentDaily.length > 0) {
    sections.push(
      "## Recent Daily Memory\n" +
        recentDaily
          .map((entry) => `### ${entry.path}\n${trimForPrompt(entry.content)}`)
          .join("\n\n"),
    );
  }

  if (sections.length === 0) {
    return null;
  }

  return (
    "<persistent_memory>\n" +
    "The following is your persistent memory from previous sessions. Use it when answering questions about your identity, the user's preferences, prior decisions, or ongoing work.\n\n" +
    sections.join("\n\n") +
    "\n</persistent_memory>"
  );
}
