import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const SENTINEL = "[WRITE]";

// Mutable state closed over by all handlers
let hasWriteIntent = false;
let agentApproved = false;

function isMutatingBash(command: string): boolean {
  const c = command.trim();

  // Check unquoted portions of the command for shell redirection operators
  const parts = c.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/);
  for (let i = 0; i < parts.length; i += 2) {
    const u = parts[i];
    if (/(?:^|\s|;|&&|\|\|)\d?>\s*\S/.test(u)) return true;
    if (/(?:^|\s|;|&&|\|\|)\d?>>\s*\S/.test(u)) return true;
  }

  // Pipe to tee (writes to file)
  if (/\|\s*tee(?:\s|$)/.test(c)) return true;

  // Here-document (e.g. cat << EOF)
  if (/<<\s*['"]?-?\w+/.test(c)) return true;

  // Known mutating command patterns
  const patterns = [
    /^rm(?:\s|$|-)/,
    /^cp(?:\s|$|-)/,
    /^mv(?:\s|$|-)/,
    /^mkdir(?:\s|$|-)/,
    /^touch(?:\s|$|-)/,
    /^chmod(?:\s|$|-)/,
    /^chown(?:\s|$|-)/,
    /^ln(?:\s|$|-)/,
    /^rmdir(?:\s|$|-)/,
    /^sed\s+(?:-i|--in-place)/,
    /\bcurl(?:\s.*)?\s+-o(?:\s|$)/,
    /\bcurl(?:\s.*)?\s+--output(?:\s|$)/,
    /\bwget(?:\s.*)?\s+-O(?:\s|$)/,
    /\bwget(?:\s.*)?\s+--output-document(?:\s|$)/,
    /^git\s+(?:push|pull|merge|commit|checkout|reset|revert|cherry-pick|stash|clean|mv)(?:\s|$)/,
    /^npm\s+(?:install|update|audit\s+fix|publish|unpublish|deprecate)(?:\s|$)/,
    /^pip(?:3)?\s+(?:install|uninstall)(?:\s|$)/,
    /^python(?:3)?(?:\s.*)?\s+-m\s+pip\s+(?:install|uninstall)(?:\s|$)/,
    /^cargo\s+install(?:\s|$)/,
    /^docker(?:-compose)?\s+(?:build|push|rm|rmi|run|up|down|exec)(?:\s|$)/,
    /^make(?:\s|$)/,
    /^npm\s+run(?:\s|$)/,
  ];

  for (const p of patterns) {
    if (p.test(c)) return true;
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, _ctx) => {
    hasWriteIntent = event.prompt.includes(SENTINEL);
  });

  pi.on("agent_start", async (_event, _ctx) => {
    agentApproved = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    let gated = false;
    let detail = "";

    if (toolName === "write" || toolName === "edit") {
      gated = true;
      detail = String((event.input as Record<string, unknown>).path ?? "");
    } else if (isToolCallEventType("bash", event)) {
      gated = isMutatingBash(event.input.command);
      detail = event.input.command;
    }

    if (!gated) return;

    // Sentinel in prompt: allow all gated calls this agent loop
    if (hasWriteIntent) return;

    // User already approved one gated call this agent loop
    if (agentApproved) return;

    const message = `[${toolName}] ${detail}\n\nApprove this write operation?`;

    // Interactive mode: show confirm popup
    if (ctx.hasUI) {
      let ok = false;
      try {
        ok = await ctx.ui.confirm("Write Gate", message);
      } catch {
        ok = false;
      }
      if (ok) {
        agentApproved = true;
        return;
      }
      return {
        block: true,
        reason: `Blocked by write gate: user did not include ${SENTINEL} and denied approval.`,
      };
    }

    // Non-interactive mode: auto-block
    return {
      block: true,
      reason: `Blocked by write gate: include ${SENTINEL} in your prompt to allow write operations.`,
    };
  });
}
