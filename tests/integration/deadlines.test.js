const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, caFirm, createUser, sql, unique } = require("./lib");

/*
 * Milestone M4: compliance deadlines and reminders (COMP-01–07, CD-07,
 * FIX-08, FIX-14/15, FIX-20), in a CA firm of its own — down to a reminder
 * email arriving in Mailpit.
 */

const MAIL = process.env.MAIL_URL || "http://localhost:18025";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let admin;
let firm;
let services;
let years;

async function client(email = `${unique("client")}@test.example`) {
  const { status, body } = await api("POST", "/customers", {
    token: firm.token,
    body: { name: unique("Client"), email, profile: { attributes: { constitution: "proprietorship" } } },
  });

  assert.equal(status, 201, JSON.stringify(body));
  return body.id;
}

async function engage(customerId, keys, period = years.current) {
  const { status, body } = await api("POST", "/engagements", {
    token: firm.token,
    body: { customerId, typeKey: "annual", period, lines: keys.map((key) => ({ serviceId: services[key] })) },
  });

  assert.equal(status, 201, JSON.stringify(body));
  return body.id;
}

const deadlines = async (customerId, period = years.current) =>
  (await api("GET", `/obligations?customerId=${customerId}&period=${period}`, { token: firm.token })).body;

const byRule = (feed, key) => feed.items.filter((item) => item.rule_key === key);

before(async () => {
  admin = await adminToken();
  firm = await caFirm(admin, "CA Firm (deadlines)");

  const list = (await api("GET", "/services", { token: firm.token })).body;
  services = Object.fromEntries(list.filter((service) => service.key).map((service) => [service.key, service.id]));
  years = (await api("GET", "/engagements/periods?type=annual", { token: firm.token })).body;
});

describe("rules", () => {
  test("the CA bundle installed its deadline rules — none yet for accounting, PF/ESIC or PTRC", async () => {
    const { body } = await api("GET", "/obligations/rules", { token: firm.token });
    const keys = body.map((rule) => rule.key);

    for (const key of ["gstr1", "gstr3b", "gstr9", "gstr9c", "tds_return", "tax_audit_report", "itr", "statutory_audit_report", "internal_audit_report", "aoc4", "mgt7"]) {
      assert.ok(keys.includes(key), `missing ${key}`);
    }

    assert.equal(body.some((rule) => ["accounting", "pf_esic", "ptrc_ptec"].includes(rule.service_key)), false);
  });
});

describe("generation (COMP-01)", () => {
  test("an engagement generates its services' deadlines — on the 11th, not a day early (FIX-08)", async () => {
    const id = await client();
    await engage(id, ["gst_returns", "itr"]);

    const feed = await deadlines(id);
    const start = Number(years.current.slice(0, 4));

    assert.equal(byRule(feed, "gstr1").length, 12);
    assert.equal(byRule(feed, "gstr3b").length, 12);
    assert.equal(byRule(feed, "gstr1").map((item) => item.due_on).sort()[0], `${start}-05-11`);
    assert.equal(byRule(feed, "itr")[0].due_on, `${start + 1}-07-31`);
    assert.equal(byRule(feed, "tds_return").length, 0, "TDS only when engaged (FIX-15)");
  });

  test("engaging a tax audit moves the ITR to 31 Oct and adds the audit report", async () => {
    const id = await client();
    const engagementId = await engage(id, ["itr"]);

    await api("PUT", `/engagements/${engagementId}`, { token: firm.token, body: { lines: [{ serviceId: services.itr }, { serviceId: services.tax_audit }] } });

    const feed = await deadlines(id);
    const start = Number(years.current.slice(0, 4));

    assert.equal(byRule(feed, "itr")[0].due_on, `${start + 1}-10-31`);
    assert.equal(byRule(feed, "tax_audit_report")[0].due_on, `${start + 1}-09-30`);
  });

  test("dropping a service drops its pending deadlines — but never a filed one", async () => {
    const id = await client();
    const engagementId = await engage(id, ["gst_returns"]);
    const first = byRule(await deadlines(id), "gstr1")[0];

    await api("PATCH", `/obligations/${first.id}`, { token: firm.token, body: { status: "filed", filedOn: first.due_on } });
    await api("PUT", `/engagements/${engagementId}`, { token: firm.token, body: { lines: [] } });

    const after = await deadlines(id);

    assert.deepEqual(after.items.map((item) => [item.id, item.status]), [[first.id, "filed"]]);
  });

  test("generating again creates nothing twice", async () => {
    const id = await client();
    await engage(id, ["gst_returns", "tds"]);
    const before = (await deadlines(id)).items.length;

    await api("POST", "/obligations/generate", { token: firm.token, body: { customerId: id } });
    await api("POST", "/obligations/generate", { token: firm.token, body: { customerId: id } });

    assert.equal((await deadlines(id)).items.length, before);
    assert.equal(before, 28);
  });
});

describe("the feed and statuses (COMP-02–05, CD-07)", () => {
  test("a past year's open deadlines are overdue, sorted first, and counted", async () => {
    const id = await client();
    const past = years.periods[1].label;
    await engage(id, ["gst_returns"], past);

    const feed = await deadlines(id, past);

    assert.equal(feed.counts.overdue, 24);
    assert.ok(feed.items.every((item) => item.state === "overdue"));
  });

  test("filing a deadline completes it, records the date and is audited", async () => {
    const id = await client();
    await engage(id, ["itr"]);
    const item = (await deadlines(id)).items[0];

    const changed = await api("PATCH", `/obligations/${item.id}`, { token: firm.token, body: { status: "filed" } });

    assert.equal(changed.status, 200, JSON.stringify(changed.body));

    const after = (await deadlines(id)).items[0];

    assert.equal(after.state, "completed");
    assert.match(after.filed_on, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(sql(`SELECT count(*) FROM audit_events WHERE action = 'obligation.status_changed' AND entity_id = '${item.id}'`), "1");
  });

  test("the Compliance tab groups by service with done and total", async () => {
    const id = await client();
    await engage(id, ["gst_returns", "itr"]);

    const { body } = await api("GET", `/obligations/customers/${id}?period=${years.current}`, { token: firm.token });
    const gst = body.services.find((group) => group.serviceKey === "gst_returns");

    assert.deepEqual([gst.done, gst.total], [0, 24]);
  });

  test("an Article Assistant updates statuses but not the rules", async () => {
    const assistant = await createUser(firm.token, "CA_ARTICLE_ASSISTANT");
    const id = await client();
    await engage(id, ["itr"]);
    const item = (await deadlines(id)).items[0];

    assert.equal((await api("PATCH", `/obligations/${item.id}`, { token: assistant.token, body: { status: "in_progress" } })).status, 200);
    assert.equal((await api("PATCH", "/obligations/rules/itr", { token: assistant.token, body: { isActive: false } })).status, 403);
  });
});

describe("extensions (FIX-20)", () => {
  test("an extension moves open deadlines of that year, and removing it moves them back", async () => {
    const id = await client();
    await engage(id, ["itr"]);
    const original = (await deadlines(id)).items[0].due_on;
    const extended = `${Number(years.current.slice(0, 4)) + 1}-11-30`;

    const saved = await api("PUT", `/obligations/rules/itr/overrides/${years.current}`, { token: firm.token, body: { dueOn: extended, reason: "CBDT circular" } });

    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.ok(saved.body.moved >= 1);
    assert.equal((await deadlines(id)).items[0].due_on, extended);

    // A client engaged after the extension gets the extended date too.
    const later = await client();
    await engage(later, ["itr"]);
    assert.equal((await deadlines(later)).items[0].due_on, extended);

    await api("DELETE", `/obligations/rules/itr/overrides/${years.current}`, { token: firm.token });
    assert.equal((await deadlines(id)).items[0].due_on, original);
  });
});

describe("reminders", () => {
  test("a deadline due soon emails its client once, when the firm has switched the reminder on", async () => {
    // The firm's own mailbox, to Mailpit, and the bundle's reminder switched on.
    const account = await api("POST", "/emails/accounts", {
      token: firm.token,
      body: {
        name: "Firm mailbox", email_address: `${unique("firm")}@test.example`, provider: "smtp",
        smtp_host: "mailpit", smtp_port: 1025, smtp_secure: false, smtp_username: "firm", smtp_password: "any",
        imap_host: "greenmail", imap_port: 3143, imap_secure: false, imap_username: "firm", imap_password: "any", imap_mailbox: "INBOX",
      },
    });
    assert.ok([200, 201].includes(account.status), JSON.stringify(account.body));

    const automations = (await api("GET", "/emails/automations", { token: firm.token })).body.automations;
    const reminder = automations.find((item) => item.trigger_event === "obligation.due_soon");
    assert.equal((await api("POST", `/emails/automations/${reminder.id}/activate`, { token: firm.token })).status, 200);

    const email = `${unique("remind")}@test.example`;
    const id = await client(email);
    const today = (await deadlines(id)).today;
    const [year, month, day] = today.split("-").map(Number);
    const dueOn = new Date(Date.UTC(year, month - 1, day + 3)).toISOString().slice(0, 10);

    const manual = await api("POST", "/obligations", { token: firm.token, body: { customerId: id, title: "Board resolution filing", dueOn } });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));

    const first = await api("POST", "/obligations/reminders/run", { token: firm.token });
    const second = await api("POST", "/obligations/reminders/run", { token: firm.token });

    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(first.body.raised >= 1);
    assert.equal(second.status, 200);
    assert.equal(sql(`SELECT count(*) FROM automation_events WHERE dedupe_key = 'obligation:${manual.body.id}:due_soon'`), "1");

    let messages = [];
    for (let attempt = 0; attempt < 40 && messages.length === 0; attempt += 1) {
      const response = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
      messages = (await response.json()).messages || [];
      if (messages.length === 0) await sleep(500);
    }

    assert.equal(messages.length, 1, "exactly one reminder");
    assert.match(messages[0].Subject, /Board resolution filing is due on/);

    // Leave the firm's reminders off again.
    await api("POST", `/emails/automations/${reminder.id}/deactivate`, { token: firm.token });
  });
});

describe("an organization without a bundle", () => {
  test("has no deadlines", async () => {
    assert.equal((await api("GET", "/obligations", { token: admin })).status, 404);
  });
});
