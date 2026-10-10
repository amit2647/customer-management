import http from "k6/http";
import { check, sleep } from "k6";

/*
 * A load smoke test: twenty users working the main read paths for thirty
 * seconds, through the gateway, against the throwaway test stack. Not a
 * capacity test — it catches a request path that has become slow or starts
 * failing under modest concurrency (a missing index, an N+1, a lock).
 *
 * Fails the run if the 95th-percentile response exceeds 800 ms or more than
 * 1% of requests fail.
 */

const API = __ENV.API_BASE || "http://localhost:18080/api";

export const options = {
  vus: 20,
  duration: "30s",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<800"],
    checks: ["rate>0.99"],
  },
};

const ADMIN = { email: "admin@test.example", password: "Test-Admin-123!" };
const GATEWAY = API.replace(/\/api\/?$/, "");

/*
 * Each virtual user signs in once, through Ory Hydra as the browser does
 * (auth-hardening P1): the flow's redirects are followed by hand, k6's
 * per-VU cookie jar keeps the state and refresh cookies, and the access token
 * comes from /auth/refresh. A run is far shorter than the token's 5 minutes.
 */
let token = null;

function absolute(location, base) {
  return /^https?:/.test(location) ? location : `${base.match(/^https?:\/\/[^/]+/)[0]}${location}`;
}

// Follows redirects while they stay on the gateway; returns where they left it.
function follow(url) {
  let location = url;
  for (let step = 0; step < 10; step += 1) {
    if (!location.startsWith(GATEWAY)) return location;
    const response = http.get(location, { redirects: 0, tags: { endpoint: "sign-in" } });
    if (!response.headers.Location) throw new Error(`sign-in stopped at ${location}: ${response.status}`);
    location = absolute(response.headers.Location, location);
  }
  throw new Error("too many redirects");
}

function signIn() {
  const loginPage = follow(`${API}/auth/start`);
  const challenge = /login_challenge=([^&]+)/.exec(loginPage)[1];

  const login = http.post(`${API}/auth/login`, JSON.stringify({ ...ADMIN, login_challenge: decodeURIComponent(challenge) }), {
    headers: { "Content-Type": "application/json" },
    tags: { endpoint: "sign-in" },
  });
  follow(login.json("redirect_to"));

  return http.post(`${API}/auth/refresh`, null, { tags: { endpoint: "sign-in" } }).json("accessToken");
}

const PATHS = ["/leads", "/customers", "/services", "/dashboard", "/assistant/conversations", "/profile"];

export default function run() {
  if (!token) token = signIn();

  const params = { headers: { Authorization: `Bearer ${token}` }, tags: {} };

  for (const path of PATHS) {
    params.tags.endpoint = path;
    const response = http.get(`${API}${path}`, params);

    check(response, { [`${path} is 200`]: (r) => r.status === 200 });
  }

  sleep(0.5);
}
