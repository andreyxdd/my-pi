/**
 * Conventional Commits Enforcement Extension
 *
 * Enforces https://www.conventionalcommits.org/en/v1.0.0/ by:
 * 1. Auto-correcting inline `git commit -m "..."` messages when they lack proper format.
 * 2. Auto-committing uncommitted changes on session shutdown with a generated conventional message.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const VALID_TYPES = [
  "revert",
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
];

// type(scope)?!: description
const CC_REGEX =
  /^(revert|feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\([a-zA-Z0-9\-_]+\))?(!)?: .+/;

const KEYWORD_MAP: [RegExp, string][] = [
  [/\b(revert|rollback|undo)\b/, "revert"],
  [/\b(fix|bug|repair|patch|resolve)\b/, "fix"],
  [/\b(doc|readme|comment|guide|documentation)\b/, "docs"],
  [/\b(style|format|lint|prettier)\b/, "style"],
  [/\b(refactor|restructure|reorganize|cleanup|clean up)\b/, "refactor"],
  [/\b(perf|speed|optimiz|performance|fast)\b/, "perf"],
  [/\b(test|spec)\b/, "test"],
  [/\b(build|deps|dependency|upgrade|bump|package)\b/, "build"],
  [/\b(ci|pipeline|workflow|github action)\b/, "ci"],
  [/\b(feat|feature|implement|support|new)\b/, "feat"],
];

function isConventional(msg: string): boolean {
  return CC_REGEX.test(msg);
}

function guessType(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [rx, type] of KEYWORD_MAP) {
    if (rx.test(lower)) return type;
  }
  return null;
}

function toConventional(text: string): string | null {
  const type = guessType(text);
  if (!type) return null;
  const cleaned = text
    .replace(/^[a-z]+\b\s*/i, "")
    .replace(/^\W+/, "")
    .trim();
  let desc = cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  if (desc.length > 72) desc = desc.slice(0, 69) + "...";
  return `${type}: ${desc || "update"}`;
}

function extractMessages(command: string): string[] | null {
  if (!/-m\b/.test(command) && !/--message\b/.test(command)) return null; // editor mode
  const rx = /(?:-m\s*|--message(?:=|\s+))(['"])(.*?)\1/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(command)) !== null) out.push(m[2]);
  return out;
}

function replaceFirstMessage(command: string, replacement: string): string | null {
  const rx = /(-m\s*|--message(?:=|\s+))(['"])(.*?)\2/;
  const m = rx.exec(command);
  if (!m) return null;
  const prefix = m[1];
  const quote = m[2];
  return command.replace(rx, () => `${prefix}${quote}${replacement}${quote}`);
}

function deriveCommitMessage(contextText: string): string {
  const first = contextText.split("\n")[0] || "Work in progress";
  const conv = toConventional(first);
  if (conv) return conv;
  return `chore: ${first.slice(0, 72)}`;
}

export default function (pi: ExtensionAPI) {
  // --- 1. Intercept `git commit` via bash and auto-correct ---
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const { command } = event.input;

    if (!/\bgit\s+commit\b/.test(command)) return undefined;
    if (/\b--amend\b/.test(command)) return undefined; // allow amend

    const messages = extractMessages(command);
    if (messages === null) return undefined; // no -m flags, opened editor — can't intercept

    if (messages.length === 0) {
      return {
        block: true,
        reason:
          "[conventional-commits] Could not extract commit message from flags.",
      };
    }

    const summary = messages[0];
    if (isConventional(summary)) return undefined;

    const corrected = toConventional(summary);
    if (!corrected) {
      return {
        block: true,
        reason:
          `[conventional-commits] Commit message is not conventional and could not be auto-corrected.\n` +
          `Message: "${summary}"\n` +
          `Expected: type(scope): description\n` +
          `Valid types: ${VALID_TYPES.join(", ")}\n\n` +
          `Tip: include a keyword (e.g. "add" for feat, "fix" for fix) or rewrite manually.`,
      };
    }

    const newCmd = replaceFirstMessage(command, corrected);
    if (!newCmd) {
      return {
        block: true,
        reason:
          `[conventional-commits] Detected bad message "${summary}" but could not rewrite command.`,
      };
    }

    event.input.command = newCmd;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `[conventional-commits] Auto-corrected: "${summary}" → "${corrected}"`,
        "info",
      );
    }

    return undefined;
  });

  // --- 2. Auto-commit on session shutdown ---
  pi.on("session_shutdown", async (_event, ctx) => {
    const { stdout: status, code } = await pi.exec(
      "git",
      ["status", "--porcelain"],
      { cwd: ctx.cwd },
    );
    if (code !== 0 || status.trim().length === 0) return;

    // Collect last assistant message text for commit context
    const entries = ctx.sessionManager.getEntries();
    let contextText = "";
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const content = entry.message.content;
      if (Array.isArray(content)) {
        contextText = content
          .filter(
            (c): c is { type: "text"; text: string } => c.type === "text",
          )
          .map((c) => c.text)
          .join("\n");
      } else if (typeof content === "string") {
        contextText = content;
      }
      break;
    }

    const commitMessage = deriveCommitMessage(contextText);

    await pi.exec("git", ["add", "-A"], { cwd: ctx.cwd });
    const { code: commitCode } = await pi.exec(
      "git",
      ["commit", "-m", commitMessage],
      { cwd: ctx.cwd },
    );

    if (commitCode === 0 && ctx.hasUI) {
      ctx.ui.notify(
        `[conventional-commits] Auto-committed: ${commitMessage}`,
        "info",
      );
    }
  });
}
