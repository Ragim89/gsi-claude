/**
 * Focused load check for PHASE 12: the screens people actually wait on, under concurrency,
 * against the real stack and its demo-data volume — not a synthetic table nobody queries.
 *
 * Fires a burst of concurrent requests at each endpoint in turn (not all endpoints at once —
 * this measures one query plan at a time, not the box's total throughput) and reports
 * p50 / p95 / error rate, the numbers a production incident is actually judged by.
 *
 *   docker compose --profile test run --rm -e API=http://api:3000/api test node /repo/scripts/load-test.mjs
 *
 * or through `scripts/verify-full.sh`'s stack, once it is up.
 */
const API = process.env.API ?? 'http://api:3000/api';
const EMAIL = process.env.SMOKE_EMAIL ?? 'admin@gsi.local';
const PASSWORD = process.env.SEED_PASSWORD ?? 'ChangeMe123!';
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 20);
const ROUNDS = Number(process.env.LOAD_ROUNDS ?? 5);

const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!loginRes.ok) {
  console.error(`Could not sign in as ${EMAIL}: ${loginRes.status} ${await loginRes.text()}`);
  process.exit(1);
}
const token = (await loginRes.json()).accessToken;
const auth = { authorization: `Bearer ${token}` };

const TARGETS = [
  { name: 'Jobs list',        path: '/jobs?limit=50' },
  { name: 'Jobs search',      path: '/jobs?search=TR&limit=50' },
  { name: 'Analytics jobs',   path: '/analytics/jobs' },
  { name: 'Analytics turnaround', path: '/analytics/turnaround' },
  { name: 'Global search',    path: '/search?q=TR' },
  { name: 'Audit log',        path: '/admin/audit?limit=50' },
  { name: 'Finance dashboard', path: '/finance/dashboard' },
  { name: 'Reports list',     path: '/reports?limit=50' },
];

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function timeOne(path) {
  const started = performance.now();
  try {
    const res = await fetch(`${API}${path}`, { headers: auth });
    const ms = performance.now() - started;
    await res.arrayBuffer(); // drain, so keep-alive sockets are reused between requests
    return { ms, ok: res.ok, status: res.status };
  } catch (err) {
    return { ms: performance.now() - started, ok: false, status: 0, error: String(err) };
  }
}

const rows = [];
for (const target of TARGETS) {
  const samples = [];
  let errors = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const batch = await Promise.all(Array.from({ length: CONCURRENCY }, () => timeOne(target.path)));
    for (const r of batch) {
      samples.push(r.ms);
      if (!r.ok) errors += 1;
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const row = {
    name: target.name,
    n: samples.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    errorRate: errors / samples.length,
  };
  rows.push(row);
  console.log(
    `${row.name.padEnd(20)} n=${row.n}  p50=${row.p50.toFixed(0)}ms  p95=${row.p95.toFixed(0)}ms  max=${row.max.toFixed(0)}ms  errors=${(row.errorRate * 100).toFixed(1)}%`,
  );
}

const failed = rows.filter((r) => r.errorRate > 0);
if (failed.length) {
  console.error(`\n${failed.length} endpoint(s) returned errors under load: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
console.log('\nload-test: complete, no errors under load');
