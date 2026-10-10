/*
 * An API access token through Ory Hydra's sign-in, as the browser gets one
 * (auth-hardening P1), for tests that set data up over the API. Playwright's
 * request context keeps the cookies (the PKCE/state cookie, Hydra's own and
 * the refresh cookie); redirects are followed by hand so the login page's
 * login_challenge can be read from Hydra's redirect.
 */

const API = process.env.API_BASE || "http://localhost:18080/api";
const GATEWAY = new URL(API).origin;

async function follow(request, url) {
  let location = url;
  for (let step = 0; step < 10; step += 1) {
    if (new URL(location).origin !== GATEWAY) return location;
    const response = await request.get(location, { maxRedirects: 0 });
    const next = response.headers().location;
    if (!next) throw new Error(`sign-in stopped at ${location}: ${response.status()}`);
    location = new URL(next, location).toString();
  }
  throw new Error("too many redirects");
}

async function apiToken(request, { email, password }) {
  const loginPage = await follow(request, `${API}/auth/start`);
  const challenge = new URL(loginPage).searchParams.get("login_challenge");

  const login = await request.post(`${API}/auth/login`, { data: { email, password, login_challenge: challenge } });
  if (login.status() !== 200) throw new Error(`sign-in failed: ${login.status()} ${await login.text()}`);
  await follow(request, (await login.json()).redirect_to);

  const refreshed = await request.post(`${API}/auth/refresh`);
  return (await refreshed.json()).accessToken;
}

module.exports = { apiToken };
