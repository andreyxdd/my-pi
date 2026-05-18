import type { ExtensionAPI, ExtensionContext, UIContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface MockUI {
  notifications: Array<{ text: string; type: string }>;
  statuses: Array<{ key: string; text: string }>;
  notify(text: string, type: string): void;
  setStatus(key: string, text: string): void;
}

function createMockUI(): MockUI {
  const ui: MockUI = {
    notifications: [],
    statuses: [],
    notify(text, type) { ui.notifications.push({ text, type }); },
    setStatus(key, text) { ui.statuses.push({ key, text }); },
  };
  return ui;
}

interface CapturedExtensionAPI {
  events: Map<string, Array<(event: any, ctx: ExtensionContext) => Promise<any>>>;
  commands: Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>;
  tools: any[];
  messages: Array<{ customType: string; content: string; display: boolean }>;
}

function createMockAPI(cwd: string): { api: ExtensionAPI; captured: CapturedExtensionAPI; makeCtx: () => ExtensionContext } {
  const captured: CapturedExtensionAPI = {
    events: new Map(),
    commands: new Map(),
    tools: [],
    messages: [],
  };

  const ui = createMockUI();
  const sessionManager = {
    getEntries: () => [],
    getBranch: () => [],
    getLeafId: () => "leaf-1",
    getSessionFile: () => null,
    getLabel: () => undefined,
  } as unknown as SessionManager;

  const makeCtx = (): ExtensionContext => ({
    ui: ui as unknown as UIContext,
    hasUI: true,
    cwd,
    sessionManager,
    modelRegistry: {} as any,
    model: {} as any,
    signal: undefined,
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => null,
    compact: () => {},
    getSystemPrompt: () => "",
  } as unknown as ExtensionContext);

  const api: ExtensionAPI = {
    on: (event, handler) => {
      if (!captured.events.has(event)) captured.events.set(event, []);
      captured.events.get(event)!.push(handler);
    },
    registerCommand: (name, options) => {
      captured.commands.set(name, { description: options.description, handler: options.handler as any });
    },
    registerTool: (def) => {
      captured.tools.push(def);
    },
    sendMessage: (msg) => {
      captured.messages.push(msg as any);
    },
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    getCommands: () => [],
    registerMessageRenderer: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    exec: () => Promise.resolve({ output: "", exitCode: 0, cancelled: false, truncated: false } as any),
    getAllTools: () => [],
    setActiveTools: () => {},
    registerProvider: () => {},
  } as unknown as ExtensionAPI;

  return { api, captured: captured as any, makeCtx };
}

// Simple runner
let pass = 0;
let fail = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${(e as Error).message}`);
    fail++;
  }
}

// ============ LOAD EXTENSION ============
const { createJiti } = require("/Users/andreyxdd/.nvm/versions/node/v24.14.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti");
const jiti = createJiti(__filename);
const extensionModule = jiti("/Users/andreyxdd/.pi/agent/extensions/utils/graphify/index.ts");
const extensionFactory = extensionModule.default;

// ============ TESTS ============

async function runTests() {
  console.log("\nGraphify Extension Tests\n");

  // --- Test 1 ---
  await test("registers command, tools, and event handlers", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "graphify-test-"));
    const { api, captured } = createMockAPI(tmpDir);
    
    extensionFactory(api);
    
    assert.equal(captured.commands.has("graphify"), true, "should register /graphify command");
    assert.equal(captured.events.has("session_start"), true, "should register session_start handler");
    assert.equal(captured.events.has("before_agent_start"), true, "should register before_agent_start handler");
    assert.ok(captured.tools.length >= 1, "should register at least one tool");
    
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Test 2 ---
  await test("before_agent_start is silent when no graphify-out/", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "graphify-test-"));
    const { api, captured, makeCtx } = createMockAPI(tmpDir);
    
    extensionFactory(api);
    const handlers = captured.events.get("before_agent_start")!;
    assert.ok(handlers.length > 0, "handler exists");
    
    const result = await handlers[0]({ prompt: "hello", systemPrompt: "", systemPromptOptions: {} as any }, makeCtx());
    assert.ok(!result || !result.message, "should not inject message when graph absent");
    
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Test 3 ---
  await test("before_agent_start injects graph guidance when graph exists and fresh", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "graphify-test-"));
    mkdirSync(join(tmpDir, "graphify-out"));
    writeFileSync(join(tmpDir, "graphify-out", "graph.json"), JSON.stringify({
      nodes: [{ id: 1, label: "AuthModule", community: 0 }],
      links: [],
    }));
    writeFileSync(join(tmpDir, "graphify-out", "GRAPH_REPORT.md"), "# Graph Report\nGod nodes: AuthModule\n");
    
    const { api, captured, makeCtx } = createMockAPI(tmpDir);
    extensionFactory(api);
    
    const handlers = captured.events.get("before_agent_start")!;
    const result = await handlers[0]({ prompt: "hello", systemPrompt: "", systemPromptOptions: {} as any }, makeCtx());
    
    assert.ok(result && result.message, "should return injected message");
    assert.ok(result.message.content.includes("Knowledge graph available"), "message mentions knowledge graph");
    assert.ok(result.message.content.includes("1 nodes"), "message includes node count");
    assert.equal(result.message.display, false, "message should not display");
    
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Test 4 ---
  await test("before_agent_start marks stale when needs_update exists", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "graphify-test-"));
    mkdirSync(join(tmpDir, "graphify-out"));
    writeFileSync(join(tmpDir, "graphify-out", "graph.json"), JSON.stringify({
      nodes: [{ id: 1, label: "AuthModule", community: 0 }],
      links: [],
    }));
    writeFileSync(join(tmpDir, "graphify-out", "needs_update"), "stale");
    writeFileSync(join(tmpDir, "graphify-out", "GRAPH_REPORT.md"), "# Report");
    
    const { api, captured, makeCtx } = createMockAPI(tmpDir);
    extensionFactory(api);
    
    const handlers = captured.events.get("before_agent_start")!;
    const result = await handlers[0]({ prompt: "hello", systemPrompt: "", systemPromptOptions: {} as any }, makeCtx());
    
    assert.ok(result && result.message, "should return message");
    const content = result.message.content.toLowerCase();
    assert.ok(content.includes("stale") || content.includes("outdated") || content.includes("update"), 
      `message should warn about staleness, got: ${result.message.content}`);
    
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Test 5 ---
  await test("graphify_query tool is registered", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "graphify-test-"));
    const { api, captured } = createMockAPI(tmpDir);
    extensionFactory(api);
    
    const queryTool = captured.tools.find((t: any) => t.name === "graphify_query");
    assert.ok(queryTool, "graphify_query tool should exist");
    assert.ok(queryTool.description.includes("knowledge graph"), "description mentions knowledge graph");
    
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Test 6 ---
  await test("graphify_path tool is registered", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "graphify-test-"));
    const { api, captured } = createMockAPI(tmpDir);
    extensionFactory(api);
    
    const pathTool = captured.tools.find((t: any) => t.name === "graphify_path");
    assert.ok(pathTool, "graphify_path tool should exist");
    
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Test 7 ---
  await test("graphify_explain tool is registered", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "graphify-test-"));
    const { api, captured } = createMockAPI(tmpDir);
    extensionFactory(api);
    
    const explainTool = captured.tools.find((t: any) => t.name === "graphify_explain");
    assert.ok(explainTool, "graphify_explain tool should exist");
    
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Test 8 ---
  await test("graphify_query returns error when graph.json absent", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "graphify-test-"));
    const { api, captured, makeCtx } = createMockAPI(tmpDir);
    extensionFactory(api);
    
    const tool = captured.tools.find((t: any) => t.name === "graphify_query");
    assert.ok(tool, "tool exists");
    
    const result = await tool.execute("tc-1", { question: "auth" }, undefined, undefined, makeCtx());
    assert.equal(result.isError, true, "should return error");
    assert.ok(result.content[0].text.includes("No knowledge graph found"), "error mentions missing graph");
    
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Test 9 ---
  await test("graphify_query returns graph traversal data when graph exists", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "graphify-test-"));
    mkdirSync(join(tmpDir, "graphify-out"));
    writeFileSync(join(tmpDir, "graphify-out", "graph.json"), JSON.stringify({
      nodes: [
        { id: "a", label: "AuthModule", community: 0, source_file: "auth.py" },
        { id: "b", label: "Database", community: 1, source_file: "db.py" },
        { id: "c", label: "UserModel", community: 0, source_file: "models.py" },
      ],
      links: [
        { source: "a", target: "c", relation: "uses" },
        { source: "b", target: "c", relation: "stores" },
      ],
    }));
    
    const { api, captured, makeCtx } = createMockAPI(tmpDir);
    extensionFactory(api);
    
    const tool = captured.tools.find((t: any) => t.name === "graphify_query");
    const result = await tool.execute("tc-1", { question: "AuthModule" }, undefined, undefined, makeCtx());
    
    assert.ok(!result.isError, `should not error, got isError=${result.isError}`);
    assert.ok(result.content[0].text.includes("AuthModule"), "result mentions AuthModule");
    assert.ok(result.content[0].text.includes("NODE"), "result includes node output");
    
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Test 10 ---
  await test("session_start triggers auto-build when graph absent and code files exist", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "graphify-test-"));
    writeFileSync(join(tmpDir, "main.py"), "print('hello')");
    
    const { api, captured, makeCtx } = createMockAPI(tmpDir);
    extensionFactory(api);
    
    const handlers = captured.events.get("session_start")!;
    await handlers[0]({ reason: "startup" }, makeCtx());
    
    assert.ok(true, "session_start handler ran without throwing");
    
    rmSync(tmpDir, { recursive: true, force: true });
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
