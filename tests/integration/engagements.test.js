const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, caFirm, createUser, sql, unique } = require("./lib");

/*
 * Milestone M3: engagements and fees (CD-06, CD-08, CD-09, WIZ-08/09,
 * FIX-21), in a CA firm of its own.
 */

let admin;
let firm;
let services;
let period;

async function newClient() {
  const { status, body } = await api("POST", "/customers", {
    token: firm.token,
    body: { name: unique("Sharma Traders"), profile: { attributes: { constitution: "proprietorship" } } },
  });

  assert.equal(status, 201, JSON.stringify(body));
  return body.id;
}

const engage = (customerId, overrides = {}, token = firm.token) =>
  api("POST", "/engagements", {
    token,
    body: {
      customerId,
      typeKey: "annual",
      period,
      appointmentOn: "2025-09-15",
      attributes: { agm_on: "2025-09-30", previous_auditor: { firm: "Old & Co", frn: "100200W", reason: "rotation" } },
      lines: [
        { serviceId: services.statutory_audit, feeAmount: 50000, expensesAmount: 2500 },
        { serviceId: services.itr, feeAmount: 15000 },
      ],
      ...overrides,
    },
  });

before(async () => {
  admin = await adminToken();
  firm = await caFirm(admin, "CA Firm (engagements)");

  const list = (await api("GET", "/services", { token: firm.token })).body;
  services = Object.fromEntries(list.filter((service) => service.key).map((service) => [service.key, service.id]));
  period = (await api("GET", "/engagements/periods?type=annual", { token: firm.token })).body.current;
});

describe("engagement types and periods", () => {
  test("the CA bundle installed its annual engagement", async () => {
    const { body } = await api("GET", "/engagements/types", { token: firm.token });

    assert.deepEqual(body.map((type) => [type.key, type.period_kind, type.period_start_month]), [["annual", "financial_year", 4]]);
    assert.equal(body[0].stages[0].key, "appointed");
  });

  test("financial years are generated around today, not hard-coded (FIX-21)", async () => {
    const { body } = await api("GET", "/engagements/periods?type=annual", { token: firm.token });

    assert.equal(body.periods.length, 5);
    assert.equal(body.periods[3].label, body.current);
    assert.ok(body.periods.every((item) => item.start.endsWith("-04-01") && item.end.endsWith("-03-31")));
  });
});

describe("engagements (CD-06, CD-09)", () => {
  test("an engagement holds its services, fees, dates and previous auditor", async () => {
    const customerId = await newClient();
    const { status, body } = await engage(customerId);

    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.periodLabel, period);
    assert.equal(body.stage, "appointed");
    assert.equal(body.attributes.previous_auditor.firm, "Old & Co");
    assert.deepEqual(body.totals, { fees: 65000, expenses: 2500, gross: 67500, received: 0, balance: 67500 });
  });

  test("one engagement per client per financial year", async () => {
    const customerId = await newClient();
    await engage(customerId);

    const second = await engage(customerId);

    assert.equal(second.status, 409);
    assert.match(second.body.error, new RegExp(`already has annual engagement for ${period}`));
  });

  test("a different year is a separate engagement", async () => {
    const customerId = await newClient();
    const years = (await api("GET", "/engagements/periods?type=annual", { token: firm.token })).body.periods;

    await engage(customerId);
    assert.equal((await engage(customerId, { period: years[2].label })).status, 201);

    const { body } = await api("GET", `/engagements?customerId=${customerId}`, { token: firm.token });

    assert.deepEqual(body.map((engagement) => engagement.periodLabel), [period, years[2].label]);
  });

  test("bundle fields are checked", async () => {
    const customerId = await newClient();
    const { status, body } = await engage(customerId, { attributes: { previous_auditor: { reason: "bored" } } });

    assert.equal(status, 400);
    assert.ok(body.details.previous_auditor);
  });

  test("an archived client takes no new engagement", async () => {
    const customerId = await newClient();
    await api("DELETE", `/customers/${customerId}`, { token: firm.token });

    assert.equal((await engage(customerId)).status, 409);
  });

  test("a new engagement raises engagement.created for automations", async () => {
    const customerId = await newClient();
    const { body } = await engage(customerId);

    // Not awaited by the request, so give the queue a moment.
    let queued = "0";
    for (let attempt = 0; attempt < 20 && queued === "0"; attempt += 1) {
      queued = sql(`SELECT count(*) FROM automation_events WHERE dedupe_key = 'engagement.created:${body.id}'`);
      if (queued === "0") await new Promise((resolve) => setTimeout(resolve, 250));
    }

    assert.equal(queued, "1");
  });
});

describe("fees (CD-08)", () => {
  test("payments reduce the balance, and are audited", async () => {
    const customerId = await newClient();
    const engagement = (await engage(customerId)).body;

    const paid = await api("POST", `/engagements/${engagement.id}/payments`, {
      token: firm.token,
      body: { amount: 40000, receivedOn: "2025-10-05", method: "Bank transfer", reference: "UTR123" },
    });

    assert.equal(paid.status, 201, JSON.stringify(paid.body));

    const after = (await api("GET", `/engagements/${engagement.id}`, { token: firm.token })).body;

    assert.deepEqual(after.totals, { fees: 65000, expenses: 2500, gross: 67500, received: 40000, balance: 27500 });
    assert.equal((await api("GET", `/engagements/${engagement.id}/payments`, { token: firm.token })).body[0].reference, "UTR123");
    assert.equal(sql(`SELECT count(*) FROM audit_events WHERE action = 'payment.recorded' AND entity_id = '${engagement.id}'`), "1");
  });

  test("an Article Assistant sees the engagement but no amounts, and records no payment", async () => {
    const customerId = await newClient();
    const engagement = (await engage(customerId)).body;
    const assistant = await createUser(firm.token, "CA_ARTICLE_ASSISTANT");

    const seen = await api("GET", `/engagements/${engagement.id}`, { token: assistant.token });

    assert.equal(seen.status, 200);
    assert.equal(seen.body.totals, undefined);
    assert.equal(seen.body.lines[0].feeAmount, undefined);
    assert.equal((await api("GET", `/engagements/${engagement.id}/payments`, { token: assistant.token })).status, 403);
    assert.equal((await api("POST", `/engagements/${engagement.id}/payments`, { token: assistant.token, body: { amount: 1, receivedOn: "2025-10-05" } })).status, 403);
  });

  test("an Accounts Executive records payments", async () => {
    const customerId = await newClient();
    const engagement = (await engage(customerId)).body;
    const accounts = await createUser(firm.token, "CA_ACCOUNTS_EXECUTIVE");

    const paid = await api("POST", `/engagements/${engagement.id}/payments`, { token: accounts.token, body: { amount: 67500, receivedOn: "2025-10-05" } });

    assert.equal(paid.status, 201);
    assert.equal((await api("GET", `/engagements/${engagement.id}`, { token: accounts.token })).body.totals.balance, 0);
  });

  test("without fees.update, fees cannot be set — and changing services keeps them", async () => {
    const role = unique("ENGAGER").toUpperCase().replace(/[^A-Z0-9]/g, "_");
    await api("POST", "/roles", {
      token: firm.token,
      body: { code: role, name: "Engagement editor", permissionCodes: ["customers.read", "engagements.read", "engagements.update", "fees.read"] },
    });
    const editor = await createUser(firm.token, role);

    const customerId = await newClient();
    assert.equal((await engage(customerId, {}, editor.token)).status, 403);

    const engagement = (await engage(customerId)).body;
    const changed = await api("PUT", `/engagements/${engagement.id}`, {
      token: editor.token,
      body: { lines: [{ serviceId: services.statutory_audit }, { serviceId: services.tds }] },
    });

    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(changed.body.lines.map((line) => line.feeAmount), [50000, 0]);
  });
});

describe("an organization without a bundle", () => {
  test("has no engagements", async () => {
    assert.equal((await api("GET", "/engagements", { token: admin })).status, 404);
  });
});
