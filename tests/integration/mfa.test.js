const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, createUser, signIn, refresh, totp, organizationWithAdmin, sql } = require("./lib");

/*
 * Two-factor sign-in (auth hardening P5), end to end through Kong and Hydra,
 * with codes made the way an authenticator app makes them.
 *
 * A code is accepted from the current 30-second step or the one either side,
 * and never a step already used, so each person here uses the current step's
 * code to switch two-factor on and the next step's (offset +30) to sign in.
 */

let admin;

before(async () => {
  admin = await adminToken();
});

// A member with two-factor switched on: { member, secret, recoveryCodes }.
async function memberWithTwoFactor(token = admin) {
  const member = await createUser(token, "SALES_REP");

  const setup = await api("POST", "/profile/mfa/setup", { token: member.token });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\/OmniCore:/);

  const enabled = await api("POST", "/profile/mfa/enable", { token: member.token, body: { code: totp(setup.body.secret) } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));

  return { member, secret: setup.body.secret, recoveryCodes: enabled.body.recoveryCodes };
}

describe("a member with two-factor on", () => {
  test("the password alone does not sign in; the code then does", async () => {
    const { member, secret, recoveryCodes } = await memberWithTwoFactor();
    assert.equal(recoveryCodes.length, 10);

    await assert.rejects(signIn(member.email, member.password), (error) => {
      assert.equal(error.step.mfa, "verify");
      assert.ok(error.step.mfaToken);
      return true;
    });

    const signed = await signIn(member.email, member.password, { code: () => totp(secret, 30) });
    assert.ok(signed.token);
    assert.equal((await refresh(signed.jar)).status, 200);
  });

  test("a code works once", async () => {
    const { member, secret } = await memberWithTwoFactor();
    const code = totp(secret, 30);

    assert.ok((await signIn(member.email, member.password, { code: () => code })).token);
    await assert.rejects(signIn(member.email, member.password, { code: () => code }), { status: 400 });
  });

  test("a recovery code signs in once", async () => {
    const { member, recoveryCodes } = await memberWithTwoFactor();

    assert.ok((await signIn(member.email, member.password, { code: () => recoveryCodes[0] })).token);
    await assert.rejects(signIn(member.email, member.password, { code: () => recoveryCodes[0] }), { status: 400 });

    const status = await api("GET", "/profile/mfa", { token: (await signIn(member.email, member.password, { code: () => recoveryCodes[1] })).token });
    assert.equal(status.body.recoveryCodesLeft, 8);
  });

  test("five wrong codes lock two-factor, even against the right code", async () => {
    const { member, secret } = await memberWithTwoFactor();

    for (let attempt = 1; attempt < 5; attempt += 1) {
      await assert.rejects(signIn(member.email, member.password, { code: () => "000000" }), { status: 400 });
    }
    await assert.rejects(signIn(member.email, member.password, { code: () => "000000" }), { status: 429, code: "mfa_locked" });
    await assert.rejects(signIn(member.email, member.password, { code: () => totp(secret, 30) }), { status: 429 });
  });

  test("the step from one sign-in cannot finish another", async () => {
    const { member, secret } = await memberWithTwoFactor();

    // The step token is tied to its own Hydra challenge.
    const first = await signIn(member.email, member.password).catch((error) => error.step);
    const crossed = await api("POST", "/auth/login/mfa", { body: { mfa_token: first.mfaToken, code: totp(secret, 30), login_challenge: "another-challenge" } });
    assert.equal(crossed.status, 400);
  });

  test("switching off needs a code; new recovery codes replace the old", async () => {
    const { member, secret, recoveryCodes } = await memberWithTwoFactor();

    assert.equal((await api("POST", "/profile/mfa/recovery-codes", { token: member.token, body: { code: "000000" } })).status, 400);
    const renewed = await api("POST", "/profile/mfa/recovery-codes", { token: member.token, body: { code: totp(secret, 30) } });
    assert.equal(renewed.status, 200);
    assert.notDeepEqual(renewed.body.recoveryCodes, recoveryCodes);

    const off = await api("POST", "/profile/mfa/disable", { token: member.token, body: { code: renewed.body.recoveryCodes[0] } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.enabled, false);
    assert.ok((await signIn(member.email, member.password)).token, "the password alone again");
  });

  test("an admin's reset switches it off, signs them out and is audited", async () => {
    const { member } = await memberWithTwoFactor();
    const listed = (await api("GET", `/users/${member.id}`, { token: admin })).body;
    assert.ok(listed.mfa_enabled_at);

    const reset = await api("POST", `/users/${member.id}/mfa/reset`, { token: admin });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));

    assert.ok((await signIn(member.email, member.password)).token, "the password alone again");
    assert.match(sql(`SELECT action FROM audit_events WHERE action = 'user.mfa_reset' AND entity_id = '${member.id}'`), /user\.mfa_reset/);
  });

  test("only system.settings may reset someone else's", async () => {
    const { member } = await memberWithTwoFactor();
    const other = await createUser(admin, "SALES_MANAGER");
    assert.equal((await api("POST", `/users/${member.id}/mfa/reset`, { token: other.token })).status, 403);
  });
});

describe("an organization that requires two-factor", () => {
  test("someone without it sets it up at sign-in, gets recovery codes once, and cannot switch it off", async () => {
    const firm = await organizationWithAdmin(admin, "MFA Required Firm");
    const member = await createUser(firm.token, "SALES_REP");

    assert.equal((await api("PUT", "/organizations/current/security", { token: member.token, body: { requireMfa: true } })).status, 403);
    const policy = await api("PUT", "/organizations/current/security", { token: firm.token, body: { requireMfa: true } });
    assert.deepEqual(policy.body, { requireMfa: true });

    let secret;
    const signed = await signIn(member.email, member.password, {
      code: (step) => {
        assert.equal(step.mfa, "enrol");
        assert.match(step.qrDataUrl, /^data:image\/png;base64,/);
        secret = step.secret;
        return totp(secret);
      },
    });
    assert.equal(signed.recoveryCodes.length, 10);

    const status = await api("GET", "/profile/mfa", { token: signed.token });
    assert.deepEqual({ enabled: status.body.enabled, required: status.body.required }, { enabled: true, required: true });

    const off = await api("POST", "/profile/mfa/disable", { token: signed.token, body: { code: totp(secret, 30) } });
    assert.equal(off.status, 409);
  });

  test("the shared test organization is never made to require it", async () => {
    const policy = await api("GET", "/organizations/current/security", { token: admin });
    assert.equal(policy.body.requireMfa, false);
  });
});
