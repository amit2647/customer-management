const { test, expect } = require("@playwright/test");

/*
 * A new installation with nothing configured: there is no admin and no
 * default password; the first visit opens setup, which needs the one-time
 * code from the migrate log (tests/run-first-run.sh reads it), names the
 * organization, creates the admin, signs them in — and then closes for good.
 */

const API = process.env.API_BASE || "http://localhost:28080/api";
const CODE = process.env.SETUP_CODE;
const shot = (page, name) => page.screenshot({ path: `screenshots/${name}.png`, fullPage: false });

const ADMIN = { name: "R. Mehta", email: "owner@mehta.example", password: "a-long-passphrase" };

test("a new installation is set up from the browser, once", async ({ page, request }) => {
  expect(CODE, "run through tests/run-first-run.sh").toBeTruthy();

  const status = await (await request.get(`${API}/setup/status`)).json();
  expect(status.required).toBe(true);
  expect(status.bundle.key).toBe("ca-practice");

  // No built-in login, and a wrong code is refused.
  const old = await request.post(`${API}/auth/login`, { data: { email: "admin@acme.example", password: "ChangeMe123!" } });
  expect([400, 401]).toContain(old.status());
  const wrong = await request.post(`${API}/setup`, {
    data: { code: "AAAA-BBBB-CCCC-DDDD", organization: { name: "Intruder Ltd" }, admin: { name: "X Y", email: "x@intruder.example", password: "a-long-passphrase" } },
  });
  expect(wrong.status()).toBe(403);

  // Any page opens setup.
  await page.addInitScript(() => localStorage.setItem("omnicore-theme", "lemon"));
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Set up OmniCore" })).toBeVisible({ timeout: 30000 });

  const form = page.getByRole("form", { name: "Set up OmniCore" });
  await form.getByLabel("Organization name").fill("Mehta & Associates");
  await form.getByLabel("Time zone").selectOption("Asia/Kolkata");
  await shot(page, "setup-organization");
  await form.getByRole("button", { name: "Continue →" }).click();

  // The profession bundle setup installs: shown, not chosen.
  await expect(form.getByRole("region", { name: "Profession bundle" })).toContainText("CA Practice");
  await shot(page, "setup-profession");
  await form.getByRole("button", { name: "Continue →" }).click();

  await form.getByLabel("Your name").fill(ADMIN.name);
  await form.getByLabel("Email").fill(ADMIN.email);
  await form.getByLabel(/^Password/).fill(ADMIN.password);
  await form.getByLabel("Confirm password").fill(ADMIN.password);
  await shot(page, "setup-administrator");
  await form.getByRole("button", { name: "Continue →" }).click();

  await expect(form.getByText(/Mehta & Associates · Asia\/Kolkata · INR/)).toBeVisible();
  await form.getByLabel(/^Setup code/).fill(CODE.toLowerCase());
  await shot(page, "setup-confirm");
  await form.getByRole("button", { name: "Finish setup" }).click();

  // Signed straight in, as the new organization's administrator.
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(ADMIN.name).first()).toBeVisible();
  // CA Practice was installed with it: its words and screens are there.
  await expect(page.getByRole("link", { name: "Clients", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Prospects", exact: true })).toBeVisible();
  await shot(page, "setup-done");

  // Closed for good: even the right code is refused now.
  expect((await (await request.get(`${API}/setup/status`)).json()).required).toBe(false);
  const again = await request.post(`${API}/setup`, {
    data: { code: CODE, organization: { name: "Second Try" }, admin: { name: "Z Z", email: "z@second.example", password: "a-long-passphrase" } },
  });
  expect(again.status()).toBe(409);

  const login = await request.post(`${API}/auth/login`, { data: { email: ADMIN.email, password: ADMIN.password } });
  expect(login.status()).toBe(200);
  const { token } = await login.json();
  const installed = await (await request.get(`${API}/bundles/installed`, { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(installed.bundle.key).toBe("ca-practice");
  // The plain CRM's generic services are gone from a CA workspace.
  const services = await (await request.get(`${API}/services`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const names = (Array.isArray(services) ? services : services.services).map((service) => service.name);
  expect(names).toContain("Statutory Audit");
  for (const generic of ["CRM Implementation", "Cloud Migration", "Data Analytics", "IT Support", "Consulting"]) {
    expect(names).not.toContain(generic);
  }
  const { organizationId } = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  const organization = await (await request.get(`${API}/organizations/${organizationId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(organization.organization?.name ?? organization.name).toBe("Mehta & Associates");
});
