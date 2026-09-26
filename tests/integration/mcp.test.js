const { test, before } = require("node:test");
const assert = require("node:assert/strict");

const { adminToken, createUser } = require("./lib");

/*
 * The MCP server (/api/mcp) exposes the same tool catalog to external AI
 * clients. It must apply the same permission filter as the in-product
 * assistant: a caller only sees, and can only call, their own tools.
 */

const API = process.env.API_BASE || "http://localhost:18080/api";

let admin;
let support;

async function rpc(token, method, params = {}) {
  const response = await fetch(`${API}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const text = await response.text();

  if (!response.ok) {
    return { status: response.status };
  }

  // Streamable HTTP answers as a server-sent event.
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");

  return { status: response.status, body: JSON.parse(data || text) };
}

before(async () => {
  admin = await adminToken();
  support = await createUser(admin, "CUSTOMER_SUPPORT_AGENT");
});

test("an anonymous client is refused", async () => {
  assert.equal((await rpc(null, "tools/list")).status, 401);
});

test("the tool list is filtered to the caller's permissions", async () => {
  const names = (await rpc(support.token, "tools/list")).body.result.tools.map((tool) => tool.name);

  assert.ok(names.includes("list_customers"));
  assert.ok(!names.includes("list_leads"), "support agents cannot read leads");
  assert.ok(!names.includes("list_users"));
});

test("write tools are labelled as changing data", async () => {
  const tools = (await rpc(admin, "tools/list")).body.result.tools;
  const create = tools.find((tool) => tool.name === "create_lead");

  assert.match(create.description, /changes data/);
});

test("a permitted tool can be called", async () => {
  const { body } = await rpc(support.token, "tools/call", { name: "list_customers", arguments: {} });

  assert.equal(body.result.isError, false);
  const data = JSON.parse(body.result.content[0].text);
  assert.ok(Array.isArray(data) || Array.isArray(data.customers));
});

test("a tool outside the caller's permissions cannot be called, even by name", async () => {
  const { body } = await rpc(support.token, "tools/call", { name: "delete_lead", arguments: { id: 1 } });

  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /not available/);
});
