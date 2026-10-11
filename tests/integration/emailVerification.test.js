const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const {
  api,
  adminToken,
  createUser,
  signIn,
  confirmEmail,
  verificationToken,
  verificationLinks,
  statusFromInside,
  unique,
  GATEWAY,
} = require("./lib");

/*
 * Email verification (auth hardening P4), with real mail: email-service sends
 * through the system mail account to Mailpit, and the tests open the links
 * the way a person would.
 */

let admin;

before(async () => {
  admin = await adminToken();
});

const PASSWORD = "Member-Pass-123!";

async function newMember() {
  const email = `${unique("verify")}@test.example`;
  const created = await api("POST", "/users", { token: admin, body: { name: unique("Member"), email, password: PASSWORD, roleCode: "SALES_REP" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { id: created.body.id, email, created: created.body };
}

describe("a member created by an admin", () => {
  test("is mailed a link, and cannot sign in until they open it", async () => {
    const member = await newMember();
    assert.deepEqual(member.created.verification, { sent: true }, "mailed, so no link is handed to the admin");

    await assert.rejects(signIn(member.email, PASSWORD), (error) => {
      assert.equal(error.status, 403);
      assert.match(error.message, /email_unverified/);
      return true;
    });

    const confirmed = await confirmEmail(member.email);
    assert.equal(confirmed.email, member.email);
    assert.ok((await signIn(member.email, PASSWORD)).token);
  });

  test("a link works once", async () => {
    const member = await newMember();
    const token = await verificationToken(member.email);

    assert.equal((await api("POST", "/auth/verify-email", { body: { token } })).status, 200);
    assert.equal((await api("POST", "/auth/verify-email", { body: { token } })).status, 400);
  });

  test("a wrong password is still just a wrong password", async () => {
    const member = await newMember();
    await assert.rejects(signIn(member.email, "not-the-password"), { status: 401 });
  });

  test("the admin can send a new link, which replaces the old one", async () => {
    const member = await newMember();
    const first = await verificationToken(member.email);

    const again = await api("POST", `/users/${member.id}/verification`, { token: admin });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.verification, { sent: true });

    const second = await verificationToken(member.email, { after: 1 });
    assert.notEqual(second, first);
    assert.equal((await api("POST", "/auth/verify-email", { body: { token: first } })).status, 400, "the old link");
    assert.equal((await api("POST", "/auth/verify-email", { body: { token: second } })).status, 200);

    assert.equal((await api("POST", `/users/${member.id}/verification`, { token: admin })).status, 409, "already confirmed");
  });

  test("resend from the login page answers the same for anyone, and mails only an unconfirmed member", async () => {
    const member = await newMember();
    await verificationToken(member.email);

    const unknown = await api("POST", "/auth/verify-email/resend", { body: { email: `${unique("nobody")}@test.example` } });
    const real = await api("POST", "/auth/verify-email/resend", { body: { email: member.email } });

    assert.equal(unknown.status, 202);
    assert.equal(real.status, 202);
    assert.deepEqual(unknown.body, real.body);
    await verificationToken(member.email, { after: 1 });
  });
});

describe("changing an email address", () => {
  test("on Profile, the new address takes effect only once its link is opened", async () => {
    const member = await createUser(admin, "SALES_REP");
    const next = `${unique("moved")}@test.example`;

    const changed = await api("PATCH", "/profile", { token: member.token, body: { email: next, currentPassword: member.password } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.email, member.email, "unchanged until confirmed");
    assert.equal(changed.body.pendingEmail, next);
    assert.deepEqual(changed.body.verification, { sent: true }, "and the link is never handed to the person");

    assert.ok((await signIn(member.email, member.password)).token, "the old address still signs in");

    await confirmEmail(next);
    assert.ok((await signIn(next, member.password)).token, "the new one now does");
    await assert.rejects(signIn(member.email, member.password), { status: 401 });
  });

  test("by an admin, it applies at once but must be confirmed before the next sign-in", async () => {
    const member = await createUser(admin, "SALES_REP");
    const next = `${unique("renamed")}@test.example`;

    const changed = await api("PUT", `/users/${member.id}`, { token: admin, body: { email: next } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.verification.sent, true);

    await assert.rejects(signIn(next, member.password), { status: 403 });
    await confirmEmail(next);
    assert.ok((await signIn(next, member.password)).token);
  });
});

describe("the system mail route", () => {
  test("is not reachable through the gateway", async () => {
    for (const path of ["/api/internal/system-mail", "/api/emails/internal/system-mail"]) {
      const response = await fetch(`${GATEWAY}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(response.status, 404, path);
    }
  });

  test("refuses a caller on the Docker network without the service credential", () => {
    const status = statusFromInside("identity-service", "http://email-service:4006/internal/system-mail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "verify-email", to: "x@test.example", link: "http://localhost/verify-email#x" }),
    });
    assert.equal(status, 401);
  });

  test("the mailed link carries the token after #, so it never reaches a server log", async () => {
    const member = await newMember();
    const token = await verificationToken(member.email);

    assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal((await verificationLinks(member.email)).length, 1);
  });
});
