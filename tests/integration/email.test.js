const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const net = require("net");

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

const REPLY_SMTP_PORT = Number(process.env.REPLY_SMTP_PORT || 13025);

/*
 * Delivers a message into GreenMail over plain SMTP, as another mail server
 * would. Enough of the protocol for one message; no dependency needed.
 */
function deliver({ from, to, raw }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(REPLY_SMTP_PORT, "localhost");
    const steps = [
      "EHLO tests.local",
      `MAIL FROM:<${from}>`,
      `RCPT TO:<${to}>`,
      "DATA",
      `${raw.replace(/\n/g, "\r\n")}\r\n.`,
      "QUIT",
    ];
    let buffer = "";

    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;

      // Act on each complete reply (last line has a space after the code).
      while (/^\d{3} .*\r?\n/m.test(buffer)) {
        const match = buffer.match(/^(\d{3}) .*\r?\n/m);
        buffer = buffer.slice(match.index + match[0].length);

        if (Number(match[1]) >= 400) {
          socket.destroy();
          return reject(new Error(`SMTP refused: ${match[0].trim()}`));
        }

        const next = steps.shift();

        if (next === undefined) {
          socket.end();
          return resolve();
        }

        socket.write(`${next}\r\n`);
      }
    });
  });
}

before(async () => {
  admin = await adminToken();

  // The organization's default account: SMTP to Mailpit, IMAP from GreenMail.
  // Reused if an earlier run on the same stack made it — a second active
  // account would leave the product with no default to send from.
  const existing = await api("GET", "/emails/accounts", { token: admin });
  if ((existing.body.accounts || []).some((account) => account.email_address === "sender@test.example")) {
    return;
  }

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
      imap_host: "greenmail",
      imap_port: 3143,
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

test("a reply to an email lands on the lead it was sent to", async () => {
  const name = unique("Replier");
  const leadEmail = `${name.toLowerCase()}@test.example`;

  const lead = await api("POST", "/leads", { token: admin, body: { name, email: leadEmail } });
  assert.equal(lead.status, 201);

  const subject = unique("Proposal");
  const sent = await api("POST", "/emails/send", {
    token: admin,
    body: { to: leadEmail, subject, text: "Here is our proposal.", leadId: lead.body.id },
  });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));

  // The Message-ID the product put on it, read from the caught copy.
  const [outgoing] = await waitFor(async () => {
    const found = await mailTo(leadEmail);
    return found.length ? found : null;
  }, { what: "outgoing email" });
  const detail = await (await fetch(`${MAIL}/api/v1/message/${outgoing.ID}`)).json();
  const messageId = detail.MessageID;
  assert.ok(messageId, "sent email has a Message-ID");

  const marker = unique("reply-body");

  await deliver({
    from: leadEmail,
    to: "sender@test.example",
    raw: [
      `From: ${name} <${leadEmail}>`,
      "To: sender@test.example",
      `Subject: Re: ${subject}`,
      `Message-ID: <${marker}@tests.local>`,
      `In-Reply-To: <${messageId}>`,
      `References: <${messageId}>`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      `Thanks, looks good. ${marker}`,
    ].join("\n"),
  });

  // email-service reads it over IMAP and threads it onto the lead.
  const inbound = await waitFor(async () => {
    const { body } = await api("GET", `/emails/communications?leadId=${lead.body.id}`, { token: admin });
    const text = JSON.stringify(body);
    return text.includes(marker) && /inbound/.test(text) ? body : null;
  }, { what: "inbound reply on the lead", timeout: 45000 });

  assert.ok(inbound);
});
