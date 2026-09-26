const { test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, unique } = require("./lib");

/*
 * The one cross-service write: converting a lead creates a customer in
 * customer-service, copies the lead's services, and marks the lead Converted.
 */

let admin;
let serviceIds;

before(async () => {
  admin = await adminToken();

  const services = (await api("GET", "/services", { token: admin })).body;
  const list = Array.isArray(services) ? services : services.services || services.data || [];

  serviceIds = list.slice(0, 2).map((service) => service.id);
  assert.ok(serviceIds.length > 0, "seeded services expected");
});

test("create, read, update and convert a lead", async () => {
  const name = unique("Lead");

  const created = await api("POST", "/leads", {
    token: admin,
    body: { name, email: `${name}@test.example`, company: "Test Co", serviceIds },
  });

  assert.equal(created.status, 201, JSON.stringify(created.body));

  const id = created.body.id;

  const read = await api("GET", `/leads/${id}`, { token: admin });
  assert.equal(read.status, 200);
  assert.equal(read.body.name, name);

  const updated = await api("PATCH", `/leads/${id}`, {
    token: admin,
    body: { status: "Qualified" },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const converted = await api("POST", `/leads/${id}/convert`, { token: admin });
  assert.equal(converted.status, 200, JSON.stringify(converted.body));

  const result = converted.body.data || converted.body;
  assert.equal(result.lead.status, "Converted");

  const customer = await api("GET", `/customers/${result.customer.id}`, { token: admin });
  assert.equal(customer.status, 200);
  assert.equal(customer.body.name, name);

  // A second conversion must not create a second customer.
  const again = await api("POST", `/leads/${id}/convert`, { token: admin });
  assert.equal(again.status, 400);
});

test("a lead needs a name", async () => {
  const { status } = await api("POST", "/leads", {
    token: admin,
    body: { email: "nameless@test.example" },
  });

  assert.equal(status, 400);
});
