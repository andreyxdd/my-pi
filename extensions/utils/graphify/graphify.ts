import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface GraphSummary {
  nodes: number;
  edges: number;
  communities: number;
  path: string;
  reportPath: string;
}

function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe({
    type: "string",
    enum: values as any,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}

let graphifyPython: string | null = null;

function findGraphifyPython(): string | null {
  if (graphifyPython) return graphifyPython;
  try {
    // Read shebang from graphify CLI
    const cli = "/Users/andreyxdd/.local/bin/graphify";
    if (existsSync(cli)) {
      const firstLine = readFileSync(cli, "utf-8").split("\n")[0];
      const match = firstLine.match(/^#!(.+)$/);
      if (match) {
        graphifyPython = match[1].trim();
        return graphifyPython;
      }
    }
  } catch { /* ignore */ }
  // Fallback: common uv tool paths
  const fallbacks = [
    "/Users/andreyxdd/.local/share/uv/tools/graphifyy/bin/python",
    "/Users/andreyxdd/.local/share/uv/tools/graphifyy/bin/python3",
  ];
  for (const p of fallbacks) {
    if (existsSync(p)) { graphifyPython = p; return p; }
  }
  return null;
}

function execCommand(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((res) => {
    const proc = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => res({ stdout, stderr, exitCode: code ?? 0 }));
  });
}

function execGraphify(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return execCommand("graphify", args, cwd);
}

function execGraphifyPython(script: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const python = findGraphifyPython();
  if (!python) return Promise.resolve({ stdout: "", stderr: "graphify python not found", exitCode: 1 });
  return execCommand(python, ["-c", script], cwd);
}

async function checkGraphifyInstalled(): Promise<boolean> {
  const { exitCode } = await execGraphify(["--help"], "/");
  return exitCode === 0;
}

async function hasCodeFiles(cwd: string): Promise<boolean> {
  const codeExts = new Set([
    ".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java",
    ".cpp", ".c", ".h", ".hpp", ".rb", ".swift", ".kt", ".cs",
    ".scala", ".php", ".cc", ".cxx", ".kts",
  ]);
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && codeExts.has(e.name.slice(e.name.lastIndexOf(".")))) return true;
      if (e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("node_modules") && !e.name.startsWith("__pycache__")) {
        const sub = readdirSync(join(cwd, e.name), { withFileTypes: true });
        for (const s of sub) {
          if (s.isFile() && codeExts.has(s.name.slice(s.name.lastIndexOf(".")))) return true;
        }
      }
    }
  } catch { /* ignore */ }
  return false;
}

async function graphNeedsRebuild(cwd: string): Promise<boolean> {
  const graphPath = join(cwd, "graphify-out", "graph.json");
  if (!existsSync(graphPath)) return true;
  const graphMtime = statSync(graphPath).mtimeMs;
  const codeExts = new Set([".py", ".js", ".ts", ".go", ".rs", ".java", ".cpp", ".c", ".rb", ".swift", ".kt", ".cs", ".scala", ".php"]);
  function scan(dir: string): boolean {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("node_modules") && !e.name.startsWith("__pycache__") && !e.name.startsWith("vendor")) {
          if (scan(p)) return true;
        } else if (e.isFile() && codeExts.has(e.name.slice(e.name.lastIndexOf(".")))) {
          if (statSync(p).mtimeMs > graphMtime) return true;
        }
      }
    } catch { /* ignore */ }
    return false;
  }
  return scan(cwd);
}

async function isGraphStale(cwd: string): Promise<boolean> {
  if (existsSync(join(cwd, "graphify-out", "needs_update"))) return true;
  return await graphNeedsRebuild(cwd);
}

async function getGraphSummary(cwd: string): Promise<GraphSummary | null> {
  const graphPath = join(cwd, "graphify-out", "graph.json");
  const reportPath = join(cwd, "graphify-out", "GRAPH_REPORT.md");
  if (!existsSync(graphPath)) return null;
  try {
    const data = JSON.parse(readFileSync(graphPath, "utf-8"));
    const nodes = data.nodes?.length ?? 0;
    const edges = data.links?.length ?? data.edges?.length ?? 0;
    const communities = new Set(data.nodes?.map((n: any) => n.community)).size;
    return { nodes, edges, communities, path: graphPath, reportPath };
  } catch {
    return null;
  }
}

async function buildGraph(cwd: string, ctx: ExtensionContext): Promise<void> {
  ctx.ui.setStatus("graphify", "Building knowledge graph...");
  const script = `
import json, sys
from pathlib import Path
from graphify.detect import detect
from graphify.extract import collect_files, extract
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json, to_html

p = Path('.')
d = detect(p)
code = [Path(f) for f in d['files'].get('code', [])]
if not code:
    print('No code files found')
    sys.exit(0)

ast = extract(code)
Path('.graphify_extract.json').write_text(json.dumps(ast))
G = build_from_json(ast)
communities = cluster(G)
cohesion = score_all(G, communities)
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
labels = {cid: f'Community {cid}' for cid in communities}
questions = suggest_questions(G, communities, labels)
report = generate(G, communities, cohesion, labels, gods, surprises, d, {'input':0,'output':0}, str(p), questions)
Path('graphify-out').mkdir(exist_ok=True)
Path('graphify-out/GRAPH_REPORT.md').write_text(report)
to_json(G, communities, 'graphify-out/graph.json')
if G.number_of_nodes() <= 5000:
    to_html(G, communities, 'graphify-out/graph.html', community_labels=labels)
print(f'Graph built: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, {len(communities)} communities')
`;
  const { stdout, stderr, exitCode } = await execGraphifyPython(script, cwd);
  ctx.ui.setStatus("graphify", stdout.trim().split("\n").pop() ?? "Graph ready");
  if (exitCode !== 0) {
    ctx.ui.notify(`Graphify build failed: ${stderr || stdout}`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  // Auto-build on session start
  pi.on("session_start", async (_event, ctx) => {
    const installed = await checkGraphifyInstalled();
    if (!installed) {
      ctx.ui.notify("Graphify not installed. Run: uv tool install graphifyy", "warning");
      return;
    }

    const cwd = resolve(ctx.cwd);
    const hasCode = await hasCodeFiles(cwd);
    if (!hasCode) return;

    const needsBuild = await graphNeedsRebuild(cwd);
    if (!needsBuild) {
      const sum = await getGraphSummary(cwd);
      if (sum) {
        const stale = await isGraphStale(cwd);
        const status = stale ? `${sum.nodes}N · ${sum.edges}E · ${sum.communities}C [STALE]` : `${sum.nodes}N · ${sum.edges}E · ${sum.communities}C`;
        ctx.ui.setStatus("graphify", status);
      }
      return;
    }

    buildGraph(cwd, ctx).catch(() => {});
  });

  // Inject graph context into system prompt when graph exists
  pi.on("before_agent_start", async (_event, ctx) => {
    const sum = await getGraphSummary(resolve(ctx.cwd));
    if (!sum) return {};

    const stale = await isGraphStale(resolve(ctx.cwd));
    const staleNote = stale ? " [STALE — run /graphify to rebuild]" : "";
    const wikiPath = join(resolve(ctx.cwd), "graphify-out", "wiki", "index.md");
    const reportPath = sum.reportPath;
    const graphPath = sum.path;

    let artifactHint = "";
    if (existsSync(wikiPath)) {
      artifactHint = `Preferred artifact: wiki at ${wikiPath}. Read this first for high-level architecture. Then read ${reportPath} for god nodes and community structure. Use graphify_query tool to explore connections.`;
    } else if (existsSync(reportPath)) {
      artifactHint = `Preferred artifact: ${reportPath} (god nodes, community structure). Use graphify_query tool to explore connections.`;
    } else {
      artifactHint = `Use graphify_query tool to explore architecture and connections. Raw graph: ${graphPath}`;
    }

    const snippet = `Knowledge graph available${staleNote}: ${sum.nodes} nodes, ${sum.edges} edges, ${sum.communities} communities. ${artifactHint}`;
    return {
      message: {
        customType: "graphify-context",
        content: snippet,
        display: false,
      },
    };
  });

  // Manual command
  pi.registerCommand("graphify", {
    description: "Build or rebuild the knowledge graph",
    handler: async (args, ctx) => {
      const installed = await checkGraphifyInstalled();
      if (!installed) {
        ctx.ui.notify("Run: uv tool install graphifyy", "error");
        return;
      }
      const cwd = resolve(ctx.cwd);
      if (!args || args.trim() === "") {
        await buildGraph(cwd, ctx);
        return;
      }
      const trimmed = args.trim();
      // Passthrough to graphify CLI for subcommands
      const { stdout, stderr, exitCode } = await execGraphify(trimmed.split(/\s+/), cwd);
      if (exitCode !== 0) {
        ctx.ui.notify(`graphify ${trimmed} failed: ${stderr || stdout}`, "error");
      } else {
        ctx.ui.notify(stdout.trim().split("\n").pop() ?? "Done", "info");
      }
    },
  });

  // Query tool callable by the LLM
  pi.registerTool({
    name: "graphify_query",
    label: "Graphify Query",
    description: "Query the project knowledge graph. Use to understand architecture, trace dependencies, find related concepts, or explore community structure. Only available if graphify-out/graph.json exists.",
    promptSnippet: "Query the codebase knowledge graph for architecture, dependencies, or concept connections",
    parameters: Type.Object({
      question: Type.String({ description: "What to search for in the graph (concept name, function, module, etc.)" }),
      mode: Type.Optional(StringEnum(["bfs", "dfs"] as const)),
      budget: Type.Optional(Type.Number({ description: "Max tokens for answer context (default 2000)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = resolve(ctx.cwd);
      const graphPath = join(cwd, "graphify-out", "graph.json");
      if (!existsSync(graphPath)) {
        return {
          content: [{ type: "text", text: "No knowledge graph found. Run /graphify first." }],
          isError: true,
        };
      }

      const args = ["query", params.question, "--graph", graphPath];
      if (params.mode === "dfs") args.push("--dfs");
      if (params.budget) args.push("--budget", String(params.budget));

      const { stdout, stderr, exitCode } = await execGraphify(args, cwd);
      if (exitCode !== 0) {
        return {
          content: [{ type: "text", text: `Graph query error: ${stderr || stdout}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: stdout || "No results" }],
        details: { question: params.question, mode: params.mode ?? "bfs" },
      };
    },
  });

  // Path tool callable by the LLM
  pi.registerTool({
    name: "graphify_path",
    label: "Graphify Path",
    description: "Find the shortest path between two nodes in the knowledge graph. Use to trace how two concepts/modules are connected.",
    promptSnippet: "Find shortest path between two graph nodes to trace connections",
    parameters: Type.Object({
      start: Type.String({ description: "Starting node label or concept" }),
      end: Type.String({ description: "Target node label or concept" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = resolve(ctx.cwd);
      const graphPath = join(cwd, "graphify-out", "graph.json");
      if (!existsSync(graphPath)) {
        return {
          content: [{ type: "text", text: "No knowledge graph found. Run /graphify first." }],
          isError: true,
        };
      }

      const { stdout, stderr, exitCode } = await execGraphify(
        ["path", params.start, params.end, "--graph", graphPath],
        cwd,
      );
      if (exitCode !== 0) {
        return {
          content: [{ type: "text", text: `Graph path error: ${stderr || stdout}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: stdout || "No path found" }],
        details: { start: params.start, end: params.end },
      };
    },
  });

  // Explain tool callable by the LLM
  pi.registerTool({
    name: "graphify_explain",
    label: "Graphify Explain",
    description: "Get a plain-language explanation of a node and its neighbors in the knowledge graph. Use to understand what a module/function does and how it connects.",
    promptSnippet: "Explain a graph node and its local neighborhood",
    parameters: Type.Object({
      node: Type.String({ description: "Node label or concept to explain" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = resolve(ctx.cwd);
      const graphPath = join(cwd, "graphify-out", "graph.json");
      if (!existsSync(graphPath)) {
        return {
          content: [{ type: "text", text: "No knowledge graph found. Run /graphify first." }],
          isError: true,
        };
      }

      const { stdout, stderr, exitCode } = await execGraphify(
        ["explain", params.node, "--graph", graphPath],
        cwd,
      );
      if (exitCode !== 0) {
        return {
          content: [{ type: "text", text: `Graph explain error: ${stderr || stdout}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: stdout || "No explanation found" }],
        details: { node: params.node },
      };
    },
  });
}
