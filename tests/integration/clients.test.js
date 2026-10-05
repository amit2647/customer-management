const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, caFirm, createUser, sql, unique } = require("./lib");

/*
 * Milestone M2: CA clients — the wizard's save, identifiers, people, bank
 * accounts, lock, archive and purge (WIZ, CD-01–05, CD-11), the prospect
 * board (PROS) and the firm profile (SET-01–03). Everything happens in a CA
 * firm of its own; the shared test organization never gets a bundle.
 */

let admin;
let firm;

const PVT_LTD = { constitution: "pvt_ltd", client_type: "regular" };
// Valid, unique-per-run identifiers: PAN is 5 letters, 4 digits, a letter.
let sequence = 0;
const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
const pan = () => `${letters(5)}${String((sequence += 1) % 10000).padStart(4, "0")}${letters(1)}`;
const cin = () => `U72200MH2015PTC${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;

function newClient(overrides = {}) {
  return {
    name: unique("Acme Pvt Ltd"),
    email: `${unique("acme")}@test.example`,
    profile: {
      address: "12 MG Road, Pune",
      attributes: PVT_LTD,
      identifiers: { pan: pan(), cin: cin() },
      people: [
        { role: "director", name: "A. Rao", designation: "Managing Director", attributes: { din: "01234567" } },
        { role: "authorised_signatory", name: "B. Shah", isSignatory: true, attributes: { resolution_on: "2026-04-01" } },
      ],
      bankAccounts: [
        { bankName: "State Bank of India", branch: "Pune", accountNumber: "123456789012", routingCode: "sbin0000123", accountType: "Current" },
        { bankName: "HDFC Bank", accountNumber: "50100200300400" },
      ],
      ...overrides.profile,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "profile")),
  };
}

async function create(body, token = firm.token) {
  return api("POST", "/customers", { token, body });
}

before(async () => {
  admin = await adminToken();
  firm = await caFirm(admin, "CA Firm (clients)");
});

describe("the client wizard's save (WIZ)", () => {
  test("a private limited company without its CIN is refused, field by field (WIZ-03)", async () => {
    const { status, body } = await create(newClient({ profile: { identifiers: { pan: pan() } } }));

    assert.equal(status, 400);
    assert.equal(body.details["identifiers.cin"], "CIN is required");
  });

  test("a constitution outside the bundle's list is refused", async () => {
    const { status, body } = await create(newClient({ profile: { attributes: { constitution: "company" } } }));

    assert.equal(status, 400);
    assert.match(body.details.constitution, /allowed values/);
  });

  test("saves the client, its identifiers, people and bank accounts in one go", async () => {
    const client = newClient();
    const { status, body } = await create(client);

    assert.equal(status, 201, JSON.stringify(body));

    const detail = await api("GET", `/customers/${body.id}`, { token: firm.token });

    assert.equal(detail.body.address, "12 MG Road, Pune");
    assert.equal(detail.body.attributes.constitution, "pvt_ltd");
    assert.deepEqual(detail.body.identifiers, { pan: client.profile.identifiers.pan, cin: client.profile.identifiers.cin });
    assert.deepEqual(detail.body.people.map((person) => person.role), ["director", "authorised_signatory"]);
    assert.equal(detail.body.people[0].attributes.din, "01234567");

    // First account primary (WIZ-10); numbers never leave the service whole.
    assert.equal(detail.body.bankAccounts[0].is_primary, true);
    assert.equal(detail.body.bankAccounts[0].account_number, "•••• 9012");
    assert.equal(detail.body.bankAccounts[0].routing_code, "SBIN0000123");
  });

  test("a duplicate PAN names the client that holds it, and nothing is half-created (WIZ-11)", async () => {
    const first = newClient();
    const created = await create(first);
    const before = Number(sql(`SELECT count(*) FROM customers WHERE organization_id = ${firm.orgId}`));

    const { status, body } = await create(newClient({ profile: { identifiers: { pan: first.profile.identifiers.pan, cin: cin() } } }));

    assert.equal(status, 409);
    assert.equal(body.error, `PAN ${first.profile.identifiers.pan} already belongs to ${first.name}`);
    assert.equal(Number(sql(`SELECT count(*) FROM customers WHERE organization_id = ${firm.orgId}`)), before);

    const check = await api("GET", `/customers/identifiers/check?type=pan&value=${first.profile.identifiers.pan.toLowerCase()}`, { token: firm.token });

    assert.deepEqual(check.body, { available: false, customer: { id: created.body.id, name: first.name, archived: false } });
  });

  test("the list finds a client by PAN and shows its identifiers (DASH-02/04)", async () => {
    const client = newClient();
    await create(client);

    const { body } = await api("GET", `/customers?q=${client.profile.identifiers.pan}`, { token: firm.token });

    assert.equal(body.length, 1);
    assert.equal(body[0].name, client.name);
    assert.equal(body[0].identifiers.cin, client.profile.identifiers.cin);
  });

  test("editing keeps the profile in step (WIZ-14) but never takes bank accounts back", async () => {
    const created = await create(newClient());
    const id = created.body.id;

    const update = await api("PUT", `/customers/${id}`, {
      token: firm.token,
      body: { name: "Renamed Pvt Ltd", profile: { attributes: { constitution: "llp" }, identifiers: { pan: pan() }, people: [] } },
    });

    assert.equal(update.status, 200, JSON.stringify(update.body));

    const detail = await api("GET", `/customers/${id}`, { token: firm.token });

    assert.equal(detail.body.name, "Renamed Pvt Ltd");
    assert.equal(detail.body.identifiers.cin, undefined, "an LLP takes no CIN");
    assert.equal(detail.body.people.length, 0);
    assert.equal(detail.body.bankAccounts.length, 2);

    const resent = await api("PUT", `/customers/${id}`, { token: firm.token, body: { profile: { attributes: { constitution: "llp" }, bankAccounts: [] } } });

    assert.equal(resent.status, 400);
  });
});

describe("bank accounts (CD-11)", () => {
  test("add, choose the primary, and removing the primary promotes the next", async () => {
    const created = await create(newClient());
    const id = created.body.id;
    const accounts = (await api("GET", `/customers/${id}/bank-accounts`, { token: firm.token })).body;

    const added = await api("POST", `/customers/${id}/bank-accounts`, { token: firm.token, body: { bankName: "ICICI", accountNumber: "000401234567" } });

    assert.equal(added.status, 201);

    await api("POST", `/customers/${id}/bank-accounts/${added.body.id}/primary`, { token: firm.token });

    let list = (await api("GET", `/customers/${id}/bank-accounts`, { token: firm.token })).body;

    assert.equal(list.find((account) => account.is_primary).id, added.body.id);

    await api("DELETE", `/customers/${id}/bank-accounts/${added.body.id}`, { token: firm.token });

    list = (await api("GET", `/customers/${id}/bank-accounts`, { token: firm.token })).body;

    assert.equal(list.length, accounts.length);
    assert.equal(list.filter((account) => account.is_primary).length, 1);
  });
});

describe("lock (CD-03)", () => {
  test("a locked client cannot be edited without profiles.lock", async () => {
    const editorRole = unique("EDITOR").toUpperCase().replace(/[^A-Z0-9]/g, "_");
    await api("POST", "/roles", {
      token: firm.token,
      body: { code: editorRole, name: "Profile editor", permissionCodes: ["customers.read", "customers.update", "profiles.read", "profiles.update"] },
    });
    const editor = await createUser(firm.token, editorRole);

    const created = await create(newClient());
    const id = created.body.id;

    assert.equal((await api("POST", `/customers/${id}/lock`, { token: editor.token })).status, 403);
    assert.equal((await api("POST", `/customers/${id}/lock`, { token: firm.token })).status, 200);

    const blocked = await api("PUT", `/customers/${id}`, { token: editor.token, body: { name: "Changed" } });

    assert.equal(blocked.status, 423);
    assert.equal((await api("PUT", `/customers/${id}`, { token: firm.token, body: { name: "Changed by a partner" } })).status, 200);

    await api("DELETE", `/customers/${id}/lock`, { token: firm.token });
    assert.equal((await api("PUT", `/customers/${id}`, { token: editor.token, body: { name: "Changed again" } })).status, 200);
  });
});

describe("archive and purge", () => {
  test("delete archives: hidden, read-only, and its PAN stays taken", async () => {
    const client = newClient();
    const id = (await create(client)).body.id;

    const removed = await api("DELETE", `/customers/${id}`, { token: firm.token });

    assert.equal(removed.body.archived, true);
    assert.equal((await api("GET", "/customers", { token: firm.token })).body.some((row) => row.id === id), false);
    assert.equal((await api("GET", "/customers?archived=true", { token: firm.token })).body.some((row) => row.id === id), true);
    assert.equal((await api("PUT", `/customers/${id}`, { token: firm.token, body: { name: "x" } })).status, 409);

    const reuse = await create(newClient({ profile: { identifiers: { pan: client.profile.identifiers.pan, cin: cin() } } }));

    assert.equal(reuse.status, 409);
    assert.match(reuse.body.error, /the archived client/);

    await api("POST", `/customers/${id}/restore`, { token: firm.token });
    assert.equal((await api("GET", "/customers", { token: firm.token })).body.some((row) => row.id === id), true);
  });

  test("purge deletes an archived client and everything about it, and leaves the audit trail", async () => {
    const client = newClient();
    const id = (await create(client)).body.id;

    assert.equal((await api("DELETE", `/customers/${id}/purge`, { token: firm.token })).status, 409, "not archived yet");

    await api("DELETE", `/customers/${id}`, { token: firm.token });
    assert.equal((await api("DELETE", `/customers/${id}/purge`, { token: firm.token })).status, 200);

    assert.equal(sql(`SELECT count(*) FROM customer_people WHERE customer_id = ${id}`), "0");
    assert.equal(sql(`SELECT count(*) FROM customer_bank_accounts WHERE customer_id = ${id}`), "0");
    assert.equal(sql(`SELECT count(*) FROM audit_events WHERE customer_id = ${id} AND action = 'customer.purged'`), "1");

    // The PAN is free again.
    assert.equal((await create(newClient({ profile: { identifiers: { pan: client.profile.identifiers.pan, cin: cin() } } }))).status, 201);
  });

  test("purging needs customers.purge", async () => {
    const manager = await createUser(firm.token, "CA_AUDIT_MANAGER");
    const id = (await create(newClient())).body.id;

    await api("DELETE", `/customers/${id}`, { token: firm.token });
    assert.equal((await api("DELETE", `/customers/${id}/purge`, { token: manager.token })).status, 403);
  });
});

describe("the prospect board (PROS)", () => {
  test("a lead moves through the bundle's columns with its quote and meeting", async () => {
    const lead = await api("POST", "/leads", { token: firm.token, body: { name: unique("Prospect"), email: `${unique("p")}@test.example` } });
    const id = lead.body.id ?? lead.body.lead?.id;

    const moved = await api("PATCH", `/leads/${id}/prospect`, {
      token: firm.token,
      body: { status: "Quote Sent", quotedFee: 45000, nextMeetingOn: "2026-10-20", notes: "Wants GST too", attributes: { constitution: "llp" } },
    });

    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.status, "Quote Sent");
    assert.equal(Number(moved.body.quoted_fee), 45000);

    assert.equal((await api("PATCH", `/leads/${id}/prospect`, { token: firm.token, body: { status: "Converted" } })).status, 400);
    assert.equal((await api("PATCH", `/leads/${id}/prospect`, { token: firm.token, body: { status: "Won" } })).status, 400);
  });

  test("converting records the client the lead became (PROS-05)", async () => {
    const lead = await api("POST", "/leads", { token: firm.token, body: { name: unique("Prospect"), email: `${unique("p")}@test.example` } });
    const id = lead.body.id ?? lead.body.lead?.id;

    const converted = await api("POST", `/leads/${id}/convert`, { token: firm.token });

    assert.equal(converted.status, 200, JSON.stringify(converted.body));
    assert.equal(converted.body.lead.converted_customer_id, converted.body.customer.id);
  });

  test("the board is not there for an organization without a bundle", async () => {
    assert.equal((await api("PATCH", "/leads/1/prospect", { token: admin, body: { status: "New" } })).status, 404);
  });
});

describe("the firm (SET-01–03)", () => {
  test("its profile carries the FRN, checked against the bundle", async () => {
    assert.equal(
      (await api("PUT", "/organizations/current/profile", { token: firm.token, body: { legalName: "Rao & Co LLP", attributes: { frn: "12" } } })).status,
      400,
    );

    const saved = await api("PUT", "/organizations/current/profile", {
      token: firm.token,
      body: { legalName: "Rao & Co LLP", city: "Pune", timeZone: "Asia/Kolkata", currency: "INR", attributes: { frn: "123456W" } },
    });

    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.attributes.frn, "123456W");
    assert.equal(saved.body.city, "Pune");
  });

  test("one default signing partner at a time (SET-02)", async () => {
    await api("POST", "/organizations/current/professionals", { token: firm.token, body: { name: "CA A. Rao", attributes: { membership_no: "123456" }, isDefaultSignatory: true } });
    await api("POST", "/organizations/current/professionals", { token: firm.token, body: { name: "CA B. Iyer", attributes: { membership_no: "654321" }, isDefaultSignatory: true } });

    const { body } = await api("GET", "/organizations/current/professionals", { token: firm.token });

    assert.deepEqual(body.filter((person) => person.is_default_signatory).map((person) => person.name), ["CA B. Iyer"]);
  });

  test("is not there for an organization without a bundle", async () => {
    assert.equal((await api("GET", "/organizations/current/profile", { token: admin })).status, 404);
  });
});

describe("an organization without a bundle", () => {
  test("has no client profile routes", async () => {
    assert.equal((await api("POST", "/customers/1/lock", { token: admin })).status, 404);
    assert.equal((await api("GET", "/customers/identifiers/check?type=pan&value=X", { token: admin })).status, 404);
  });

  test("cannot send a profile", async () => {
    assert.equal((await api("POST", "/customers", { token: admin, body: { name: unique("X"), profile: {} } })).status, 400);
  });
});
