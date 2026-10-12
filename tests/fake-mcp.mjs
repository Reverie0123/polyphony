// A tiny MCP server over stdio for tests: three tools, one of which fails on purpose, one returns an image.
import { createInterface } from "node:readline";

const tools = [
  { name: "list_windows", description: "List windows", inputSchema: { type: "object", properties: {} } },
  { name: "click", description: "Click at x,y", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
  { name: "screenshot", description: "Take a screenshot", inputSchema: { type: "object", properties: {} } },
];
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-deskdock", version: "0.0.1" }, instructions: "Fake DeskDock for tests." } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  else if (msg.method === "tools/call") {
    const { name, arguments: args = {} } = msg.params;
    if (name === "list_windows") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "1: 记事本 (notepad.exe)\n2: Edge (msedge.exe)" }] } });
    else if (name === "click") {
      if (args.x < 0) send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "denied by policy: notepad is read-only" }], isError: true } });
      else send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `clicked ${args.x},${args.y}` }] } });
    } else if (name === "screenshot") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "screen 1" }, { type: "image", data: PNG_1x1, mimeType: "image/png" }] } });
    else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown tool" } });
  } else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
});
