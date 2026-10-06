const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, caFirm, createUser, sql, unique } = require("./lib");

/*
 * Milestone M5: documents (DOC-01–15, CD-12) in a CA firm of its own — the
 * letters the bundle installs, which apply to whom, pre-filled previews,
 * drafts, the firm's own text, and finalizing.
 */

let admin;
let firm;
let services;
let year;

async function client(name = unique("Client")) {
  const { status, body } = await api("POST", "/customers", {
    token: firm.token,
    body: { name, address: "12 MG Road, Pune", profile: { attributes: { constitution: "pvt_ltd" }, identifiers: { pan: `AAACA${String(Date.now()).slice(-4)}A`, cin: `U72200MH2015PTC${String(Date.now()).slice(-6)}` } } },
  });
  assert.equal(status, 201, JSON.stringify(body));
  return body.id;
}

async function engage(customerId, lines, attributes = {}) {
  const { status, body } = await api("POST", "/engagements", { token: firm.token, body: { customerId, typeKey: "annual", period: year, lines, attributes } });
  assert.equal(status, 201, JSON.stringify(body));
  return body.id;
}

const tilesFor = async (customerId) =>
  Object.fromEntries((await api("GET", `/documents/templates?customerId=${customerId}&period=${year}`, { token: firm.token })).body.map((tile) => [tile.key, tile]));

before(async () => {
  admin = await adminToken();
  firm = await caFirm(admin, "CA Firm (documents)");

  services = Object.fromEntries((await api("GET", "/services", { token: firm.token })).body.filter((s) => s.key).map((s) => [s.key, s.id]));
  year = (await api("GET", "/engagements/periods?type=annual", { token: firm.token })).body.current;

  await api("PUT", "/organizations/current/profile", { token: firm.token, body: { legalName: "Rao & Co LLP", city: "Pune", attributes: { frn: "123456W" } } });
  await api("POST", "/organizations/current/professionals", { token: firm.token, body: { name: "CA A. Rao", designation: "Partner", isDefaultSignatory: true, attributes: { membership_no: "123456" } } });
});

describe("templates", () => {
  test("the CA bundle installs its eight letters, in order", async () => {
    const { status, body } = await api("GET", "/documents/templates", { token: firm.token });

    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.map((tile) => tile.key), [
      "statutory_engagement_letter", "tax_audit_engagement_letter", "consent_appointment", "previous_auditor_letter",
      "representation_statutory", "representation_tax_audit", "noc_outgoing_auditor", "power_of_attorney",
    ]);
    assert.ok(body.every((tile) => tile.version === 1 && tile.source === "bundle"));
  });

  test("a letter applies only when its condition holds, and says why not (DOC-09)", async () => {
    const id = await client();
    await engage(id, [{ serviceId: services.statutory_audit, feeAmount: 50000 }]);

    const tiles = await tilesFor(id);

    assert.equal(tiles.statutory_engagement_letter.enabled, true);
    assert.equal(tiles.consent_appointment.enabled, true);
    assert.equal(tiles.tax_audit_engagement_letter.enabled, false);
    assert.equal(tiles.tax_audit_engagement_letter.reason, "Needs Tax Audit engaged for this year");
    assert.equal(tiles.previous_auditor_letter.enabled, false);
  });

  test("the previous-auditor letters apply once a previous auditor is recorded", async () => {
    const id = await client();
    await engage(id, [{ serviceId: services.statutory_audit }], { previous_auditor: { firm: "Old & Co", frn: "100200W", reason: "rotation" } });

    const tiles = await tilesFor(id);

    assert.equal(tiles.previous_auditor_letter.enabled, true);
    assert.equal(tiles.noc_outgoing_auditor.enabled, true);
  });
});

describe("preview and drafts", () => {
  test("a preview is pre-filled from the engagement, escapes client data and stores nothing (DOC-11, FIX-03)", async () => {
    const id = await client(unique("Acme <b>Pvt</b> Ltd"));
    await engage(id, [{ serviceId: services.statutory_audit, feeAmount: 50000, expensesAmount: 2500 }]);

    const { status, body } = await api("POST", "/documents/preview", { token: firm.token, body: { templateKey: "statutory_engagement_letter", customerId: id, period: year } });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.values.fee, 50000);
    assert.equal(body.values.expenses, 2500);
    assert.match(body.html, /₹50,000/);
    assert.match(body.html, /Acme &lt;b&gt;Pvt&lt;\/b&gt; Ltd/);
    assert.match(body.html, /Rao &amp; Co LLP/);
    assert.ok(body.missing.includes("Reference number"));
    assert.equal(body.firm.frn, "123456W");
    assert.equal(sql(`SELECT count(*) FROM generated_documents WHERE customer_id = ${id}`), "0");
  });

  test("a letter that does not apply cannot be started", async () => {
    const id = await client();
    await engage(id, [{ serviceId: services.itr }]);

    const { status } = await api("POST", "/documents", { token: firm.token, body: { templateKey: "tax_audit_engagement_letter", customerId: id, period: year } });

    assert.equal(status, 409);
  });

  test("a draft keeps its fields, and cannot be finalized while the wording is still to be supplied", async () => {
    const id = await client();
    await engage(id, [{ serviceId: services.statutory_audit, feeAmount: 40000 }]);

    const created = await api("POST", "/documents", { token: firm.token, body: { templateKey: "consent_appointment", customerId: id, period: year, fieldValues: { reference: "CA/26/1" } } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.status, "draft");

    const finalized = await api("POST", `/documents/${created.body.id}/finalize`, { token: firm.token, body: {} });

    assert.equal(finalized.status, 409);
    assert.match(finalized.body.error, /Still missing: .*Wording/);
  });

  test("an Article Assistant reads documents but cannot make them", async () => {
    const assistant = await createUser(firm.token, "CA_ARTICLE_ASSISTANT");
    const id = await client();

    assert.equal((await api("GET", `/documents/templates?customerId=${id}&period=${year}`, { token: assistant.token })).status, 200);
    assert.equal((await api("POST", "/documents", { token: assistant.token, body: { templateKey: "consent_appointment", customerId: id, period: year } })).status, 403);
    assert.equal((await api("PUT", "/documents/templates/consent_appointment", { token: assistant.token, body: { body: "<p>x</p>" } })).status, 403);
  });
});

describe("the firm's own text, and finalizing", () => {
  const FIRM_TEXT = "<p>{{firm.name}}</p><p>Ref {{fields.reference}}</p><p>We consent to act as auditors of {{client.name}} for FY {{period.label}}.</p><p>{{signatory.name}}</p>";

  test("refuses text that breaks the template rules", async () => {
    for (const body of ["<p>{{client.name}}</p><script>alert(1)</script>", "<p>{{{client.name}}}</p>", "<p>{{fields.discount}}</p>"]) {
      const response = await api("PUT", "/documents/templates/consent_appointment", { token: firm.token, body: { body } });
      assert.equal(response.status, 400, body);
      assert.ok(response.body.details.body, body);
    }
  });

  test("an edit is a new version; a letter made earlier keeps the text it was made from", async () => {
    const id = await client();
    await engage(id, [{ serviceId: services.statutory_audit }]);
    const before = (await api("POST", "/documents", { token: firm.token, body: { templateKey: "consent_appointment", customerId: id, period: year, fieldValues: { reference: "OLD/1" } } })).body;

    const edited = await api("PUT", "/documents/templates/consent_appointment", { token: firm.token, body: { body: FIRM_TEXT } });

    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.version, 2);
    assert.equal(edited.body.customized, true);

    // The earlier draft, re-rendered, is still version 1's text.
    const reapplied = await api("PUT", `/documents/${before.id}`, { token: firm.token, body: { fieldValues: { reference: "OLD/2" } } });
    assert.equal(reapplied.body.template_version, 1);
    assert.match(reapplied.body.rendered_html, /Wording: consent/);

    // A new letter takes the firm's text, and with nothing missing it finalizes.
    const after = (await api("POST", "/documents", { token: firm.token, body: { templateKey: "consent_appointment", customerId: id, period: year, fieldValues: { reference: "NEW/1" } } })).body;
    assert.equal(after.template_version, 2);
    assert.match(after.rendered_html, /We consent to act as auditors/);

    const finalized = await api("POST", `/documents/${after.id}/finalize`, { token: firm.token, body: { udin: "26123456AAAAAA1234" } });
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    assert.equal(finalized.body.status, "final");
    assert.equal(finalized.body.udin, "26123456AAAAAA1234");
    assert.equal(sql(`SELECT count(*) FROM audit_events WHERE action = 'document.finalized' AND entity_id = '${after.id}'`), "1");

    // Final is final.
    assert.equal((await api("PUT", `/documents/${after.id}`, { token: firm.token, body: { fieldValues: { reference: "X" } } })).status, 409);
    assert.equal((await api("DELETE", `/documents/${after.id}`, { token: firm.token })).status, 409);

    // Restoring the bundle's text brings version 1 back; the finalized letter is untouched.
    const restored = await api("POST", "/documents/templates/consent_appointment/restore", { token: firm.token });
    assert.equal(restored.body.version, 1);
    assert.equal(restored.body.customized, false);
    assert.match((await api("GET", `/documents/${after.id}`, { token: firm.token })).body.rendered_html, /We consent to act as auditors/);
  });

  test("installing the bundle again keeps the firm's text (upgrades keep edits)", async () => {
    await api("PUT", "/documents/templates/power_of_attorney", { token: firm.token, body: { body: "<p>{{client.name}} appoints {{firm.name}}.</p>" } });

    const reinstall = await api("PUT", "/documents/bundles/ca-practice/0.5.0", {
      token: firm.token,
      body: { documents: [{ key: "power_of_attorney", name: "Special power of attorney — DSC and portal access", revision: 2, body: "<p>Newer bundle text for {{client.name}}.</p>", fields: { type: "object", properties: {} } }] },
    });

    assert.equal(reinstall.status, 200, JSON.stringify(reinstall.body));
    assert.equal(reinstall.body.kept, 1);

    const detail = (await api("GET", "/documents/templates/power_of_attorney", { token: firm.token })).body;
    assert.equal(detail.customized, true);
    assert.match(detail.body, /appoints/);
    assert.equal(detail.updateAvailable, "0.5.0");

    // Restore takes the newer bundle text the firm had not taken.
    const restored = (await api("POST", "/documents/templates/power_of_attorney/restore", { token: firm.token })).body;
    assert.match(restored.body, /Newer bundle text/);
  });
});

describe("an organization without a bundle", () => {
  test("has no documents", async () => {
    assert.equal((await api("GET", "/documents/templates", { token: admin })).status, 404);
  });
});
