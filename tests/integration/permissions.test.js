const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, createUser } = require("./lib");

/*
 * Role-based access, enforced by the service that owns the data. A support
 * agent reads customers but not leads; a sales rep works leads but cannot
 * delete them or manage people.
 */

let admin;
let rep;
let support;

before(async () => {
  admin = await adminToken();
  rep = await createUser(admin, "SALES_REP");
  support = await createUser(admin, "CUSTOMER_SUPPORT_AGENT");
});

describe("Sales Representative", () => {
  test("can read leads", async () => {
    assert.equal((await api("GET", "/leads", { token: rep.token })).status, 200);
  });

  test("cannot delete a lead", async () => {
    const { status } = await api("DELETE", "/leads/1", { token: rep.token });

    assert.equal(status, 403);
  });

  test("cannot list users or roles", async () => {
    assert.equal((await api("GET", "/roles", { token: rep.token })).status, 403);
  });

  test("cannot grant access", async () => {
    const { status } = await api("POST", "/access-grants", {
      token: rep.token,
      body: { user_id: rep.id, permission_code: "leads.delete", duration_minutes: 15, reason: "x" },
    });

    assert.equal(status, 403);
  });
});

describe("Customer Support Agent", () => {
  test("can read customers", async () => {
    assert.equal((await api("GET", "/customers", { token: support.token })).status, 200);
  });

  test("cannot read leads", async () => {
    assert.equal((await api("GET", "/leads", { token: support.token })).status, 403);
  });
});

describe("assigning permissions needs system.settings", () => {
  test("a user cannot change their own role, even as an admin", async () => {
    const me = (await api("GET", "/profile", { token: admin })).body;

    const { status } = await api("PUT", `/users/${me.id}`, {
      token: admin,
      body: { roleCode: "SALES_REP" },
    });

    assert.equal(status, 400);
  });
});
