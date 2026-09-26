const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, createUser, login, sql, unique, uuid } = require("./lib");

/*
 * Organizations never see each other's data. The outsider is a Super Admin of
 * a second organization — the strongest caller there is — and still must get
 * nothing of the first: not by listing, not by id, not through the assistant.
 */

let admin;
let outsider;
let leadId;
let customerId;
let conversationId;

before(async () => {
  admin = await adminToken();

  // Data in organization 1.
  const name = unique("Tenant1Lead");
  const lead = await api("POST", "/leads", {
    token: admin,
    body: { name, email: `${name}@test.example`, company: "Org One Co" },
  });
  leadId = lead.body.id;

  const customers = (await api("GET", "/customers", { token: admin })).body;
  customerId = (Array.isArray(customers) ? customers : customers.customers || customers.data)[0].id;

  conversationId = uuid();
  await api("POST", `/assistant/conversations/${conversationId}/messages`, {
    token: admin,
    body: { clientMessageId: uuid(), content: "organization one secret" },
  });

  // A second organization, and a Super Admin who belongs only to it. The API
  // cannot move a user between organizations, so the fixture does it in SQL.
  const created = await createUser(admin, "SUPER_ADMIN");
  const slug = unique("org-two");
  const orgId = sql(
    `INSERT INTO organizations (name, slug) VALUES ('Organization Two', '${slug}') RETURNING id`,
  ).split("\n")[0];

  sql(`UPDATE organization_users SET organization_id = ${orgId} WHERE user_id = ${created.id}`);

  outsider = await login(created.email, created.password);
});

describe("an admin of another organization", () => {
  test("sees none of the first organization's leads in the list", async () => {
    const { status, body } = await api("GET", "/leads", { token: outsider });
    const list = Array.isArray(body) ? body : body.leads || body.data || [];

    assert.equal(status, 200);
    assert.ok(!list.some((lead) => lead.id === leadId));
  });

  test("cannot read, change or delete a lead by its id", async () => {
    assert.equal((await api("GET", `/leads/${leadId}`, { token: outsider })).status, 404);
    assert.equal(
      (await api("PATCH", `/leads/${leadId}`, { token: outsider, body: { name: "Taken" } })).status,
      404,
    );
    assert.equal((await api("DELETE", `/leads/${leadId}`, { token: outsider })).status, 404);

    const still = await api("GET", `/leads/${leadId}`, { token: admin });
    assert.equal(still.status, 200);
    assert.notEqual(still.body.name, "Taken");
  });

  test("cannot read a customer by its id", async () => {
    assert.equal((await api("GET", `/customers/${customerId}`, { token: outsider })).status, 404);
  });

  test("sees only their own organization's people", async () => {
    const { body } = await api("GET", "/organizations/1/users", { token: outsider });
    const list = Array.isArray(body) ? body : body?.users || [];

    assert.ok(!list.some((user) => user.email === "admin@test.example"));
  });

  test("cannot open the first organization's assistant conversation", async () => {
    const { status } = await api("GET", `/assistant/conversations/${conversationId}/messages`, {
      token: outsider,
    });

    assert.equal(status, 404);
  });

  test("does not find it by searching either", async () => {
    const { body } = await api("GET", "/assistant/conversations/search?q=secret", { token: outsider });

    assert.ok(!body.results.some((result) => result.id === conversationId));
  });

  test("cannot grant access to a user of the first organization", async () => {
    const me = (await api("GET", "/profile", { token: admin })).body;

    const { status } = await api("POST", "/access-grants", {
      token: outsider,
      body: { user_id: me.id, permission_code: "leads.read", duration_minutes: 15, reason: "x" },
    });

    assert.ok([400, 403, 404].includes(status), `got ${status}`);
  });
});
