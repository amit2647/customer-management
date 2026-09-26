const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, createUser, login, unique } = require("./lib");

/*
 * The record lifecycles beyond leads: customers, the service catalog, custom
 * roles, and removing a user.
 */

let admin;

const list = (body, key) => (Array.isArray(body) ? body : body?.[key] || body?.data || []);

before(async () => {
  admin = await adminToken();
});

describe("customers", () => {
  test("create, read, update, change services, delete", async () => {
    const services = list((await api("GET", "/services", { token: admin })).body, "services");
    const name = unique("Customer");

    const created = await api("POST", "/customers", {
      token: admin,
      body: { name, email: `${name}@test.example`, company: "Cust Co", serviceIds: [services[0].id] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;

    assert.equal((await api("GET", `/customers/${id}`, { token: admin })).body.name, name);

    const updated = await api("PUT", `/customers/${id}`, {
      token: admin,
      body: { name: `${name} Renamed`, email: `${name}@test.example`, company: "Cust Co" },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    const reassigned = await api("PUT", `/customers/${id}/services`, {
      token: admin,
      body: { serviceIds: services.slice(0, 2).map((service) => service.id) },
    });
    assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));

    const deleted = await api("DELETE", `/customers/${id}`, { token: admin });
    assert.ok([200, 204].includes(deleted.status));
    assert.equal((await api("GET", `/customers/${id}`, { token: admin })).status, 404);
  });

  test("invalid service ids are refused", async () => {
    const { status } = await api("POST", "/customers", {
      token: admin,
      body: { name: unique("Bad"), email: "bad@test.example", serviceIds: [-1] },
    });

    assert.equal(status, 400);
  });
});

describe("service catalog", () => {
  test("create, update, delete", async () => {
    const name = unique("Service");

    const created = await api("POST", "/services", {
      token: admin,
      body: { name, description: "Test service", category: "Testing" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;

    const updated = await api("PUT", `/services/${id}`, {
      token: admin,
      body: { name: `${name} v2`, description: "Updated", category: "Testing", status: "Active" },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    // A soft delete: leads and customers still reference the service, so it
    // is marked Inactive rather than removed.
    const deleted = await api("DELETE", `/services/${id}`, { token: admin });
    assert.ok([200, 204].includes(deleted.status), JSON.stringify(deleted.body));

    const after = await api("GET", `/services/${id}`, { token: admin });
    assert.equal((after.body.service || after.body).status, "Inactive");
  });

  test("names are unique within the organization", async () => {
    const name = unique("Dup");

    await api("POST", "/services", { token: admin, body: { name } });

    assert.equal((await api("POST", "/services", { token: admin, body: { name } })).status, 409);
  });
});

describe("custom roles", () => {
  test("a custom role grants exactly its permissions, from the next sign-in", async () => {
    const code = unique("AUDITOR").toUpperCase().replace(/-/g, "_");

    const role = await api("POST", "/roles", {
      token: admin,
      body: { code, name: "Auditor", description: "Reads leads only" },
    });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    const roleId = role.body.id ?? role.body.role?.id;

    const setPermissions = await api("PUT", `/roles/${roleId}/permissions`, {
      token: admin,
      body: { permissionCodes: ["leads.read"] },
    });
    assert.equal(setPermissions.status, 200, JSON.stringify(setPermissions.body));

    const member = await createUser(admin, code);

    assert.equal((await api("GET", "/leads", { token: member.token })).status, 200);
    assert.equal((await api("GET", "/customers", { token: member.token })).status, 403);

    await api("PUT", `/roles/${roleId}/permissions`, {
      token: admin,
      body: { permissionCodes: ["leads.read", "customers.read"] },
    });

    // Permissions are baked into the token: the old one is unchanged...
    assert.equal((await api("GET", "/customers", { token: member.token })).status, 403);

    // ...and the next sign-in picks the change up.
    const fresh = await login(member.email, member.password);
    assert.equal((await api("GET", "/customers", { token: fresh })).status, 200);
  });

  test("built-in roles cannot be edited", async () => {
    const roles = list((await api("GET", "/roles", { token: admin })).body, "roles");
    const builtIn = roles.find((role) => role.code === "SALES_REP");

    const { status } = await api("PUT", `/roles/${builtIn.id}/permissions`, {
      token: admin,
      body: { permissionCodes: ["system.settings"] },
    });

    assert.equal(status, 409);
  });
});

describe("removing a user", () => {
  test("a deleted user can no longer sign in", async () => {
    const member = await createUser(admin, "SALES_REP");

    const deleted = await api("DELETE", `/users/${member.id}`, { token: admin });
    assert.ok([200, 204].includes(deleted.status), JSON.stringify(deleted.body));

    await assert.rejects(login(member.email, member.password));
  });
});
