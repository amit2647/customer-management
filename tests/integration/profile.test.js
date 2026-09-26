const { test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, createUser, login, unique } = require("./lib");

/*
 * Self-service profile, end to end: the change reaches the database and the
 * next sign-in, and only ever affects the caller.
 */

let admin;

before(async () => {
  admin = await adminToken();
});

test("rename, change email and password, then sign in with the new ones", async () => {
  const member = await createUser(admin, "SALES_REP");

  const renamed = await api("PATCH", "/profile", { token: member.token, body: { name: "Renamed Member" } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, "Renamed Member");

  const newEmail = `${unique("moved")}@test.example`;

  const noPassword = await api("PATCH", "/profile", { token: member.token, body: { email: newEmail } });
  assert.equal(noPassword.status, 400, "email change needs the password");

  const moved = await api("PATCH", "/profile", {
    token: member.token,
    body: { email: newEmail, currentPassword: member.password },
  });
  assert.equal(moved.status, 200);

  const changed = await api("PUT", "/profile/password", {
    token: member.token,
    body: { currentPassword: member.password, newPassword: "Brand-New-123!" },
  });
  assert.equal(changed.status, 204);

  await assert.rejects(login(newEmail, member.password), "old password no longer works");
  assert.ok(await login(newEmail, "Brand-New-123!"), "new email and password work");
});

test("a profile edit cannot reach another user", async () => {
  const member = await createUser(admin, "SALES_REP");
  const before = (await api("GET", "/profile", { token: admin })).body;

  await api("PATCH", "/profile", {
    token: member.token,
    body: { id: before.id, userId: before.id, name: "Hijacked" },
  });

  assert.equal((await api("GET", "/profile", { token: admin })).body.name, before.name);
});

test("an email already in use is refused", async () => {
  const one = await createUser(admin, "SALES_REP");
  const two = await createUser(admin, "SALES_REP");

  const { status } = await api("PATCH", "/profile", {
    token: two.token,
    body: { email: one.email, currentPassword: two.password },
  });

  assert.equal(status, 409);
});
