const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, caFirm, sql, unique } = require("./lib");

/*
 * A lead and the customer it became are one entity, kept by two services
 * (migration 017): leads.converted_customer_id points forward,
 * customers.source_lead_id points back. Conversion is safe to retry, and a
 * customer won before conversions were recorded can be linked by hand.
 */

let admin;
let firm;

const lead = async (token, extra = {}) => {
  const created = await api("POST", "/leads", { token, body: { name: unique("Prospect"), email: `${unique("p")}@test.example`, ...extra } });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  return created.body.id ?? created.body.lead?.id;
};

const client = async () => {
  const created = await api("POST", "/customers", {
    token: firm.token,
    body: { name: unique("Client"), profile: { attributes: { constitution: "proprietorship" } } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.id;
};

before(async () => {
  admin = await adminToken();
  firm = await caFirm(admin, "CA Firm (lead link)");
});

describe("converting", () => {
  test("links both sides and carries the prospect's notes to the client", async () => {
    const id = await lead(firm.token);
    await api("PATCH", `/leads/${id}/prospect`, { token: firm.token, body: { status: "Quote Sent", quotedFee: 45000, notes: "Met at the GST seminar" } });

    const converted = await api("POST", `/leads/${id}/convert`, { token: firm.token });
    assert.equal(converted.status, 200, JSON.stringify(converted.body));

    const customer = (await api("GET", `/customers/${converted.body.customer.id}`, { token: firm.token })).body;

    assert.equal(customer.source_lead_id, id);
    assert.equal(customer.notes, "Met at the GST seminar");
    assert.equal((await api("GET", `/leads/${id}`, { token: firm.token })).body.converted_customer_id, customer.id);
  });

  test("a retry after the lead update failed finds the client instead of making a second", async () => {
    const id = await lead(firm.token);
    const name = unique("Retried");

    // The first half of a conversion, as lead-service makes it, twice over.
    const first = await api("POST", "/customers/from-lead", { token: firm.token, body: { name, leadId: id } });
    const second = await api("POST", "/customers/from-lead", { token: firm.token, body: { name, leadId: id } });

    assert.equal(second.body.customer.id, first.body.customer.id);

    // And the conversion itself then completes onto that same client.
    const converted = await api("POST", `/leads/${id}/convert`, { token: firm.token });
    assert.equal(converted.body.customer.id, first.body.customer.id);
    assert.equal(sql(`SELECT count(*) FROM customers WHERE source_lead_id = ${id}`), "1");
  });

  test("a converted prospect stays as it was", async () => {
    const id = await lead(firm.token);
    await api("POST", `/leads/${id}/convert`, { token: firm.token });

    const moved = await api("PATCH", `/leads/${id}/prospect`, { token: firm.token, body: { status: "New" } });

    assert.equal(moved.status, 409);
    assert.match(moved.body.error, /already a client/);
  });
});

describe("linking by hand", () => {
  test("ties an existing client to its prospect, from both sides", async () => {
    const customerId = await client();
    const id = await lead(firm.token);

    const linked = await api("POST", `/leads/${id}/link`, { token: firm.token, body: { customerId } });

    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.body.lead.status, "Converted");
    assert.equal((await api("GET", `/customers/${customerId}`, { token: firm.token })).body.source_lead_id, id);

    // Again: nothing changes.
    assert.equal((await api("POST", `/leads/${id}/link`, { token: firm.token, body: { customerId } })).status, 200);
  });

  test("a client keeps the first prospect it was won from; a later enquiry still links to it", async () => {
    const customerId = await client();
    const first = await lead(firm.token);
    const later = await lead(firm.token);

    await api("POST", `/leads/${first}/link`, { token: firm.token, body: { customerId } });
    const again = await api("POST", `/leads/${later}/link`, { token: firm.token, body: { customerId } });

    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal((await api("GET", `/customers/${customerId}`, { token: firm.token })).body.source_lead_id, first);
    assert.equal((await api("GET", `/leads/${later}`, { token: firm.token })).body.converted_customer_id, customerId);
  });

  test("a prospect already tied to another client is refused", async () => {
    const one = await client();
    const other = await client();
    const id = await lead(firm.token);

    await api("POST", `/leads/${id}/link`, { token: firm.token, body: { customerId: one } });
    const refused = await api("POST", `/leads/${id}/link`, { token: firm.token, body: { customerId: other } });

    assert.equal(refused.status, 409);
    assert.equal((await api("GET", `/customers/${other}`, { token: firm.token })).body.source_lead_id, null);
  });

  test("another organization's client cannot be linked", async () => {
    const id = await lead(admin);
    const customerId = await client();

    assert.equal((await api("POST", `/leads/${id}/link`, { token: admin, body: { customerId } })).status, 404);
    assert.equal((await api("GET", `/leads/${id}`, { token: admin })).body.status, "New");
  });
});

describe("an organization without a bundle", () => {
  test("converts as before, and the customer now knows its lead", async () => {
    const id = await lead(admin);

    const converted = await api("POST", `/leads/${id}/convert`, { token: admin });

    assert.equal(converted.status, 200, JSON.stringify(converted.body));
    assert.equal(converted.body.lead.status, "Converted");
    assert.equal((await api("GET", `/customers/${converted.body.customer.id}`, { token: admin })).body.source_lead_id, id);
    assert.equal((await api("POST", `/leads/${id}/convert`, { token: admin })).status, 400);
  });
});
