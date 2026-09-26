const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, unique, waitFor } = require("./lib");

/*
 * Real SMTP delivery, caught by Mailpit in the test stack (nothing leaves the
 * machine), and email automations end to end: switched on, an event sends
 * exactly one rendered email; switched off, it sends none.
 */

const MAIL = process.env.MAIL_URL || "http://localhost:18025";

let admin;

async function mailTo(address) {
  const response = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
  const { messages = [] } = await response.json();

  return messages;
}

async function messageBody(id) {
  const response = await fetch(`${MAIL}/api/v1/message/${id}`);
  const message = await response.json();

  return `${message.Subject}\n${message.Text || ""}\n${message.HTML || ""}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  admin = await adminToken();

  // The organization's default account, pointed at Mailpit. The IMAP side is
  // required by the form but unused here.
  const created = await api("POST", "/emails/accounts", {
    token: admin,
    body: {
      name: "Test mailbox",
      email_address: "sender@test.example",
      provider: "smtp",
      smtp_host: "mailpit",
      smtp_port: 1025,
      smtp_secure: false,
      smtp_username: "sender@test.example",
      smtp_password: "any",
      imap_host: "mailpit",
      imap_port: 1143,
      imap_secure: false,
      imap_username: "sender@test.example",
      imap_password: "any",
      imap_mailbox: "INBOX",
    },
  });

  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
});

test("an email sent from the product is delivered", async () => {
  const to = `${unique("recipient")}@test.example`;
  const subject = unique("Subject");

  const sent = await api("POST", "/emails/send", {
    token: admin,
    body: { to, subject, text: "Hello from the integration tests" },
  });

  assert.equal(sent.status, 202, JSON.stringify(sent.body));

  const [message] = await waitFor(async () => {
    const found = await mailTo(to);
    return found.length ? found : null;
  }, { what: "delivered email" });

  assert.equal(message.Subject, subject);
});

describe("automations", () => {
  let automation;

  before(async () => {
    const { body } = await api("GET", "/emails/automations", { token: admin });

    automation = body.automations.find((item) => item.trigger_event === "lead.created");
    assert.ok(automation, "the seeded lead.created automation");
    assert.equal(automation.is_active, false, "seeded switched off");
  });

  after(async () => {
    await api("POST", `/emails/automations/${automation.id}/deactivate`, { token: admin });
  });

  test("switched off, creating a lead sends nothing", async () => {
    const name = unique("Quiet");
    const email = `${name.toLowerCase()}@test.example`;

    await api("POST", "/leads", { token: admin, body: { name, email } });
    await sleep(4000);

    assert.equal((await mailTo(email)).length, 0);
  });

  test("switched on, creating a lead sends exactly one rendered email", async () => {
    const activated = await api("POST", `/emails/automations/${automation.id}/activate`, { token: admin });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));

    const name = unique("Welcome");
    const email = `${name.toLowerCase()}@test.example`;

    const lead = await api("POST", "/leads", { token: admin, body: { name, email } });
    assert.equal(lead.status, 201);

    const [message] = await waitFor(async () => {
      const found = await mailTo(email);
      return found.length ? found : null;
    }, { what: "automation email" });

    const content = await messageBody(message.ID);

    assert.match(content, new RegExp(name), "placeholder filled with the lead's name");
    assert.doesNotMatch(content, /\{\{\s*lead\.name\s*\}\}/, "no unrendered lead.name");

    // Give the runner several more polls: the event must not send twice.
    await sleep(4000);
    assert.equal((await mailTo(email)).length, 1);
  });
});
