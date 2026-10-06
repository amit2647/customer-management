const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");
const { spawnSync } = require("child_process");

const { api, adminToken, caFirm, createUser, sql, unique } = require("./lib");

/*
 * Milestone M6: the vault (CD-10, CD-13, FIX-02, FIX-22) in a CA firm of its
 * own — credentials only after the signed consent, secrets only through an
 * audited reveal, files kept in SeaweedFS and removed when a client is purged.
 */

const API = process.env.API_BASE || "http://localhost:18080/api";
const PASSWORD = "Gst@2026!secret";

let admin;
let firm;

async function client() {
  const { status, body } = await api("POST", "/customers", { token: firm.token, body: { name: unique("Vault Client"), profile: { attributes: { constitution: "proprietorship" } } } });
  assert.equal(status, 201, JSON.stringify(body));
  return body.id;
}

async function upload(token, customerId, category, bytes = Buffer.from("%PDF-1.4 signed consent"), name = "POA signed.pdf") {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/pdf" }), name);
  const response = await fetch(`${API}/vault/customers/${customerId}/files?category=${category}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const saveGst = (token, customerId, fields = { username: "acme_gst", password: PASSWORD }) =>
  api("PUT", `/vault/customers/${customerId}/credentials/gst`, { token, body: { fields } });

// Reads an object straight from SeaweedFS, from inside vault-service.
function objectExists(objectKey) {
  const script = `const { S3Client, HeadObjectCommand } = require("@aws-sdk/client-s3");
    const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY } });
    s3.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: ${JSON.stringify(objectKey)} })).then(() => console.log("present"), (e) => console.log(e.name === "NotFound" || e.$metadata?.httpStatusCode === 404 ? "absent" : "error " + e.name));`;
  const result = spawnSync("docker", ["compose", "-p", "cmtest", "-f", "docker-compose.yml", "-f", "docker-compose.test.yml", "exec", "-T", "vault-service", "node", "-e", script], {
    cwd: path.join(__dirname, "..", ".."),
    encoding: "utf8",
  });
  return result.stdout.trim();
}

before(async () => {
  admin = await adminToken();
  firm = await caFirm(admin, "CA Firm (vault)");
});

describe("credentials (CD-10, FIX-02)", () => {
  test("the bundle's nine portals are listed, and none is saved before the signed consent is on file", async () => {
    const id = await client();
    const listed = (await api("GET", `/vault/customers/${id}/credentials`, { token: firm.token })).body;

    assert.equal(listed.vaultReady, true);
    assert.equal(listed.portals.length, 9);
    assert.deepEqual(listed.consent, { category: "consent_poa_signed", onFile: false });

    const refused = await saveGst(firm.token, id);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /signed consent/);
  });

  test("once the consent is on file, a credential is saved — and its secret never leaves in a listing or in the clear", async () => {
    const id = await client();
    assert.equal((await upload(firm.token, id, "consent_poa_signed")).status, 201);

    const saved = await saveGst(firm.token, id);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const gst = saved.body.portals.find((portal) => portal.key === "gst");
    assert.deepEqual(gst.credential.publicFields, { username: "acme_gst" });
    assert.equal(gst.credential.hasSecret, true);
    assert.equal(JSON.stringify(saved.body).includes(PASSWORD), false);

    // At rest: ciphertext only.
    assert.equal(sql(`SELECT count(*) FROM portal_credentials WHERE customer_id = ${id} AND position(convert_to('${PASSWORD}', 'UTF8') in secret_ciphertext) > 0`), "0");
    assert.equal(sql(`SELECT count(*) FROM portal_credentials WHERE customer_id = ${id} AND public_fields::text LIKE '%${PASSWORD}%'`), "0");
  });

  test("a reveal needs a reason, returns the secret uncached, and is recorded", async () => {
    const id = await client();
    await upload(firm.token, id, "consent_poa_signed");
    await saveGst(firm.token, id);

    assert.equal((await api("POST", `/vault/customers/${id}/credentials/gst/reveal`, { token: firm.token, body: { reason: "" } })).status, 400);

    const response = await fetch(`${API}/vault/customers/${id}/credentials/gst/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${firm.token}` },
      body: JSON.stringify({ reason: "Filing GSTR-3B for August" }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.secrets.password, PASSWORD);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(sql(`SELECT count(*) FROM credential_reveals WHERE customer_id = ${id} AND reason = 'Filing GSTR-3B for August'`), "1");
    assert.equal(sql(`SELECT count(*) FROM audit_events WHERE action = 'credential.revealed' AND customer_id = ${id}`), "1");
  });

  test("a secret left blank is kept when other fields change", async () => {
    const id = await client();
    await upload(firm.token, id, "consent_poa_signed");
    await saveGst(firm.token, id);

    await saveGst(firm.token, id, { username: "acme_gst_new", password: "" });
    const revealed = await api("POST", `/vault/customers/${id}/credentials/gst/reveal`, { token: firm.token, body: { reason: "Checking the login" } });

    assert.equal(revealed.body.secrets.password, PASSWORD);
  });

  test("an Article Assistant sees logins but not passwords — until a partner grants a reveal just in time", async () => {
    const id = await client();
    await upload(firm.token, id, "consent_poa_signed");
    await saveGst(firm.token, id);
    const assistant = await createUser(firm.token, "CA_ARTICLE_ASSISTANT");

    assert.equal((await api("GET", `/vault/customers/${id}/credentials`, { token: assistant.token })).status, 200);
    assert.equal((await api("POST", `/vault/customers/${id}/credentials/gst/reveal`, { token: assistant.token, body: { reason: "Filing the return" } })).status, 403);
    assert.equal((await saveGst(assistant.token, id)).status, 403);

    const granted = await api("POST", "/access-grants", { token: firm.token, body: { user_id: assistant.id, permission_code: "vault.reveal", duration_minutes: 15, reason: "GSTR-3B filing" } });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));

    const revealed = await api("POST", `/vault/customers/${id}/credentials/gst/reveal`, { token: assistant.token, body: { reason: "Filing the return" } });
    assert.equal(revealed.status, 200, JSON.stringify(revealed.body));
  });

  test("the assistant has no vault tool, for anyone (no secret reaches the model)", async () => {
    const response = await fetch(`${API}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${firm.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = await response.text();
    const data = JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("") || text);
    const names = data.result.tools.map((tool) => tool.name).join(" ");

    assert.equal(/vault|credential|password|portal|file/i.test(names), false, names);
  });

  test("the power of attorney lists only the portals the client has credentials for (FIX-22)", async () => {
    const id = await client();
    await upload(firm.token, id, "consent_poa_signed");
    await saveGst(firm.token, id);

    const { body } = await api("POST", "/documents/preview", { token: firm.token, body: { templateKey: "power_of_attorney", customerId: id } });

    assert.match(body.html, /<li>GST portal<\/li>/);
    assert.equal(body.html.includes("MCA21"), false);
  });
});

describe("files (CD-13)", () => {
  test("round-trip through SeaweedFS: the same bytes come back, always as an attachment", async () => {
    const id = await client();
    const bytes = crypto.randomBytes(4096);
    const uploaded = await upload(firm.token, id, "general", bytes, "<script>evil</script>.html");

    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));

    const response = await fetch(`${API}/vault/files/${uploaded.body.id}/download`, { headers: { Authorization: `Bearer ${firm.token}` } });
    const back = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.ok(back.equals(bytes));
    assert.match(response.headers.get("content-disposition"), /^attachment;/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
  });

  test("the gateway and the service refuse a file over 25 MB", async () => {
    const id = await client();
    const { status } = await upload(firm.token, id, "general", Buffer.alloc(25 * 1024 * 1024 + 1));

    assert.equal(status, 413);
  });

  test("another organization's file is not found", async () => {
    const id = await client();
    const uploaded = await upload(firm.token, id, "general");
    const other = await caFirm(admin, "CA Firm (vault, other)");

    assert.equal((await fetch(`${API}/vault/files/${uploaded.body.id}/download`, { headers: { Authorization: `Bearer ${other.token}` } })).status, 404);
    assert.equal((await api("GET", `/vault/customers/${id}/files`, { token: other.token })).status, 404);
  });

  test("the signed consent cannot be deleted while credentials rely on it", async () => {
    const id = await client();
    const poa = await upload(firm.token, id, "consent_poa_signed");
    await saveGst(firm.token, id);

    assert.equal((await api("DELETE", `/vault/files/${poa.body.id}`, { token: firm.token })).status, 409);

    await api("DELETE", `/vault/customers/${id}/credentials/gst`, { token: firm.token });
    assert.equal((await api("DELETE", `/vault/files/${poa.body.id}`, { token: firm.token })).status, 200);
  });

  test("purging a client removes its credentials, and the sweeper removes its files from SeaweedFS", async () => {
    const id = await client();
    const poa = await upload(firm.token, id, "consent_poa_signed");
    await saveGst(firm.token, id);
    await api("POST", "/vault/customers/" + id + "/credentials/gst/reveal", { token: firm.token, body: { reason: "Before the purge" } });
    const objectKey = sql(`SELECT object_key FROM client_files WHERE id = ${poa.body.id}`);

    assert.equal(objectExists(objectKey), "present");

    assert.equal((await api("POST", `/customers/${id}/archive`, { token: firm.token })).status, 200);
    const purged = await api("DELETE", `/customers/${id}/purge`, { token: firm.token });
    assert.equal(purged.status, 200, JSON.stringify(purged.body));

    assert.equal(sql(`SELECT count(*) FROM portal_credentials WHERE customer_id = ${id}`), "0");
    assert.equal(sql(`SELECT customer_id IS NULL FROM client_files WHERE id = ${poa.body.id}`), "t");

    const swept = await api("POST", "/vault/files/sweep", { token: firm.token });
    assert.equal(swept.status, 200, JSON.stringify(swept.body));
    assert.ok(swept.body.removed >= 1);
    assert.equal(sql(`SELECT count(*) FROM client_files WHERE id = ${poa.body.id}`), "0");
    assert.equal(objectExists(objectKey), "absent");

    // The record of who looked outlives the client.
    assert.equal(sql(`SELECT count(*) FROM credential_reveals WHERE customer_id = ${id}`), "1");
  });
});

describe("an organization without a bundle", () => {
  test("has no vault", async () => {
    assert.equal((await api("GET", "/vault/customers/1/credentials", { token: admin })).status, 404);
  });
});
