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

export function setup() {
  const response = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email: "admin@test.example", password: "Test-Admin-123!" }),
    { headers: { "Content-Type": "application/json" } },
  );

  return { token: response.json("token") };
}

const PATHS = ["/leads", "/customers", "/services", "/dashboard", "/assistant/conversations", "/profile"];

export default function run({ token }) {
  const params = { headers: { Authorization: `Bearer ${token}` }, tags: {} };

  for (const path of PATHS) {
    params.tags.endpoint = path;
    const response = http.get(`${API}${path}`, params);

    check(response, { [`${path} is 200`]: (r) => r.status === 200 });
  }

  sleep(0.5);
}
