const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, createUser, modelCalls, unique, uuid, waitFor } = require("./lib");

/*
 * The assistant against a scripted model (tests/fake-openrouter). The
 * guarantees under test: conversations persist, a retried message never asks
 * twice, one reply runs at a time, a confirmed change runs exactly once from
 * the stored arguments, and conversations are private.
 */

let admin;

before(async () => {
  admin = await adminToken();
});

function send(token, conversationId, content, clientMessageId = uuid()) {
  return api("POST", `/assistant/conversations/${conversationId}/messages`, {
    token,
    body: { clientMessageId, content },
  });
}

const lastText = (result) => result.body.messages.at(-1)?.content;

describe("conversations", () => {
  test("a reply is stored and survives a reload", async () => {
    const conversation = uuid();

    const sent = await send(admin, conversation, "hello there");
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(lastText(sent), "Echo: hello there");

    const page = await api("GET", `/assistant/conversations/${conversation}/messages`, { token: admin });
    assert.deepEqual(
      page.body.messages.map((message) => message.role),
      ["user", "assistant"],
    );
  });

  test("a retried message returns the stored answer without calling the model", async () => {
    const conversation = uuid();
    const messageId = uuid();

    await send(admin, conversation, "only once", messageId);
    const callsAfterFirst = await modelCalls();

    const retry = await send(admin, conversation, "only once", messageId);

    assert.equal(retry.status, 200);
    assert.equal(retry.body.replayed, true);
    assert.equal(await modelCalls(), callsAfterFirst, "the model was asked again");

    const page = await api("GET", `/assistant/conversations/${conversation}/messages`, { token: admin });
    assert.equal(page.body.messages.filter((message) => message.role === "user").length, 1);
  });

  test("only one reply runs at a time in a conversation", async () => {
    const conversation = uuid();

    await send(admin, conversation, "warm up");

    const [slow, second] = await Promise.all([
      send(admin, conversation, "SLOW 1500 first"),
      new Promise((resolve) => setTimeout(resolve, 300)).then(() => send(admin, conversation, "second")),
    ]);

    assert.equal(slow.status, 200);
    assert.equal(second.status, 409);
  });

  test("a failed turn is marked, and retrying it answers it", async () => {
    const conversation = uuid();
    const messageId = uuid();
    const content = `FAILONCE ${unique("k")} please`;

    const failed = await send(admin, conversation, content, messageId);
    assert.ok(failed.status >= 500, `expected a failure, got ${failed.status}`);

    const page = await api("GET", `/assistant/conversations/${conversation}/messages`, { token: admin });
    assert.equal(page.body.messages[0].status, "failed");

    const retried = await send(admin, conversation, content, messageId);
    assert.equal(retried.status, 200);
    assert.match(lastText(retried), /^Echo:/);
  });

  test("another user's conversation does not exist for you", async () => {
    const conversation = uuid();
    await send(admin, conversation, "private");

    const other = await createUser(admin, "SALES_REP");

    const peek = await api("GET", `/assistant/conversations/${conversation}/messages`, { token: other.token });
    assert.equal(peek.status, 404);

    const write = await send(other.token, conversation, "intrude");
    assert.equal(write.status, 404);
  });
});

describe("confirmed changes", () => {
  async function propose(name) {
    const conversation = uuid();
    const args = JSON.stringify({ name, email: `${name}@test.example`, company: "Assistant Co" });

    const proposed = await send(admin, conversation, `TOOL create_lead ${args}`);

    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    assert.equal(proposed.body.pendingAction?.name, "create_lead");

    return { conversation, action: proposed.body.pendingAction };
  }

  async function leadsNamed(name) {
    const { body } = await api("GET", `/leads?q=${encodeURIComponent(name)}`, { token: admin });
    const list = Array.isArray(body) ? body : body.leads || body.data || [];

    return list.filter((lead) => lead.name === name);
  }

  test("nothing is written until confirmed", async () => {
    const name = unique("Proposed");

    await propose(name);

    assert.equal((await leadsNamed(name)).length, 0);
  });

  test("a double-clicked Confirm writes exactly once", async () => {
    const name = unique("Once");
    const { conversation, action } = await propose(name);

    const path = `/assistant/conversations/${conversation}/actions/${action.id}/confirm`;
    const results = await Promise.all([
      api("POST", path, { token: admin }),
      api("POST", path, { token: admin }),
    ]);

    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal((await leadsNamed(name)).length, 1);
  });

  test("confirm runs the stored arguments, not what the client sends", async () => {
    const name = unique("Stored");
    const { conversation, action } = await propose(name);

    await api("POST", `/assistant/conversations/${conversation}/actions/${action.id}/confirm`, {
      token: admin,
      body: { arguments: { name: "Tampered" } },
    });

    assert.equal((await leadsNamed(name)).length, 1);
    assert.equal((await leadsNamed("Tampered")).length, 0);
  });

  test("cancel writes nothing, and a cancelled change cannot then be confirmed", async () => {
    const name = unique("Cancelled");
    const { conversation, action } = await propose(name);
    const base = `/assistant/conversations/${conversation}/actions/${action.id}`;

    assert.equal((await api("POST", `${base}/cancel`, { token: admin })).status, 200);
    assert.equal((await api("POST", `${base}/confirm`, { token: admin })).status, 409);
    assert.equal((await leadsNamed(name)).length, 0);
  });

  test("a tool the caller lacks is refused, not proposed", async () => {
    const support = await createUser(admin, "CUSTOMER_SUPPORT_AGENT");

    const result = await send(support.token, uuid(), 'TOOL delete_lead {"id": 1}');

    assert.equal(result.status, 200);
    assert.equal(result.body.pendingAction, null);
    assert.match(lastText(result), /not available/);
  });
});

describe("search and help", () => {
  test("a conversation becomes searchable by its words", async () => {
    const word = unique("zebrafish");
    const conversation = uuid();

    await send(admin, conversation, `notes about ${word}`);

    // Looked up by id rather than taken from the top: until the message is
    // embedded, an unrelated conversation can tie with it on meaning alone.
    const found = await waitFor(
      async () => {
        const { body } = await api("GET", `/assistant/conversations/search?q=${word}`, { token: admin });
        return body.results?.find((result) => result.id === conversation);
      },
      { what: "search result" },
    );

    assert.ok(found.snippet.includes(word));
    assert.ok(found.matchedBy.includes("words"));
  });

  test("product help is filtered to the caller's permissions", async () => {
    const ask = 'TOOL search_help {"question": "How do I create a custom role?"}';

    const asAdmin = await send(admin, uuid(), ask);
    assert.match(lastText(asAdmin), /New Role/);

    const rep = await createUser(admin, "SALES_REP");
    const asRep = await send(rep.token, uuid(), ask);
    assert.doesNotMatch(lastText(asRep), /New Role/);
  });
});

describe("long conversations", () => {
  test("a fact from before the context window is recalled into the prompt", async () => {
    const conversation = uuid();
    const fact = unique("quokka-renewal");

    await send(admin, conversation, `Remember: the renewal codeword is ${fact}.`);

    // Wait until that message is embedded (found by meaning, not just words).
    await waitFor(async () => {
      const { body } = await api("GET", `/assistant/conversations/search?q=${fact}`, { token: admin });
      return body.results?.some((result) => result.id === conversation && result.matchedBy.includes("meaning"));
    }, { what: "the fact to be embedded" });

    // Push it out of the 40-message window.
    for (let i = 0; i < 22; i += 1) {
      await send(admin, conversation, `Filler message number ${i} about the weather.`);
    }

    await send(admin, conversation, "What was the renewal codeword?");

    const last = await (await fetch(`${process.env.FAKE_MODEL_URL || "http://localhost:18099"}/__last`)).json();
    const system = last.messages.find((message) => message.role === "system").content;
    const thread = last.messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n");

    assert.ok(!thread.includes(fact), "the fact must be outside the window for this test to mean anything");
    assert.ok(system.includes(fact), "recall brought the fact back");
  });
});
