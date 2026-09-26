/*
 * A scripted stand-in for OpenRouter, used only by the integration tests.
 *
 * The last user message is the script:
 *
 *   TOOL <name> <json args>   → the model calls that tool with those args
 *   SLOW <ms> <text>          → waits, then echoes (to hold a turn open)
 *   FAILONCE <key> <text>     → 500 the first time for <key>, then echoes
 *   anything else             → "Echo: <text>"
 *
 * After a tool result comes back, it replies "Tool said: <result>", so a test
 * can see what a tool returned even though tool traffic is never sent to the
 * browser.
 *
 * GET /__calls returns how many completions were requested, so a test can
 * prove a retried message did not reach the model a second time.
 */

const http = require("http");

let calls = 0;
let toolCallCounter = 0;
const failedOnce = new Set();

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function reply(message) {
  return { id: "fake", object: "chat.completion", choices: [{ index: 0, message }] };
}

function lastUserText(messages) {
  const user = [...messages].reverse().find((message) => message.role === "user");

  return typeof user?.content === "string" ? user.content : "";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function complete(body, res) {
  const messages = body.messages || [];
  const last = messages[messages.length - 1];

  if (last?.role === "tool") {
    return send(res, 200, reply({ role: "assistant", content: `Tool said: ${last.content}` }));
  }

  const text = lastUserText(messages);

  const tool = text.match(/^TOOL (\w+)\s*(\{.*\})?\s*$/s);

  if (tool) {
    toolCallCounter += 1;

    return send(
      res,
      200,
      reply({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: `call_${toolCallCounter}`,
            type: "function",
            function: { name: tool[1], arguments: tool[2] || "{}" },
          },
        ],
      }),
    );
  }

  const slow = text.match(/^SLOW (\d+) (.*)$/s);

  if (slow) {
    await sleep(Number(slow[1]));
    return send(res, 200, reply({ role: "assistant", content: `Echo: ${slow[2]}` }));
  }

  const failOnce = text.match(/^FAILONCE (\S+) (.*)$/s);

  if (failOnce && !failedOnce.has(failOnce[1])) {
    failedOnce.add(failOnce[1]);
    return send(res, 500, { error: { message: "scripted failure" } });
  }

  return send(res, 200, reply({ role: "assistant", content: `Echo: ${text}` }));
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/__calls") {
    return send(res, 200, { calls });
  }

  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { status: "ok" });
  }

  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    calls += 1;

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      complete(JSON.parse(raw || "{}"), res).catch((error) =>
        send(res, 500, { error: { message: error.message } }),
      );
    });
    return undefined;
  }

  return send(res, 404, { error: "not found" });
});

server.listen(Number(process.env.PORT || 4099), () => {
  console.log(`[fake-openrouter] listening on ${server.address().port}`);
});
