/**
 * The working-stack smoke check: every module asked the question its screen asks.
 *
 * The unit and integration suites prove the code is right against a throwaway database. This
 * proves the assembled stack is right — the real database with its migrations applied, the real
 * object store, the real images — which is where a migration that touched one table and broke a
 * join in another shows up. It only reads; it changes nothing.
 *
 *   docker compose --profile test run --rm test node /repo/scripts/smoke.mjs
 *
 * or through `scripts/verify-full.sh`, which starts the stack first.
 */
const API = process.env.API ?? 'http://api:3000/api';
const EMAIL = process.env.SMOKE_EMAIL ?? 'admin@gsi.local';
const PASSWORD = process.env.SEED_PASSWORD ?? 'ChangeMe123!';

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const res = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!res.ok) {
  console.error(`Could not sign in as ${EMAIL}: ${res.status} ${await res.text()}`);
  console.error('Is the stack up, and is SEED_PASSWORD the one it was seeded with?');
  process.exit(1);
}
const token = (await res.json()).accessToken;

const get = async (path) => {
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const type = r.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return { status: r.status, body: await r.json() };
  return { status: r.status, body: await r.arrayBuffer() };
};

const rows = (b) => (Array.isArray(b) ? b : b?.rows ?? []);
const ok = (r) => r.status === 200;
const nonEmpty = (r) => ok(r) && rows(r.body).length > 0;
const first = async (path) => rows((await get(path)).body)[0];

console.log('\nCRM');
const client = await first('/clients?limit=1');
check('clients paginate', nonEmpty(await get('/clients?limit=5')));
check('client card opens', ok(await get(`/clients/${client.id}`)));
check('client contacts', ok(await get(`/clients/${client.id}/contacts`)));
check('contracts paginate', ok(await get('/contracts?limit=5')));

console.log('\nJobs');
const job = await first('/jobs?limit=1');
check('job register', nonEmpty(await get('/jobs?limit=5')));
check('job card opens', ok(await get(`/jobs/${job.id}`)));
check('job history', ok(await get(`/jobs/${job.id}/history`)));
check('job assignments', ok(await get(`/jobs/${job.id}/assignments`)));
check('job filters by client', ok(await get(`/jobs?clientId=${client.id}&limit=3`)));

console.log('\nInspections');
const inspection = await first('/inspections?limit=1');
check('inspection register', nonEmpty(await get('/inspections?limit=5')));
check('inspection card opens', ok(await get(`/inspections/${inspection.id}`)));
check('checklist', ok(await get(`/inspections/${inspection.id}/checklist`)));
check('findings', ok(await get(`/inspections/${inspection.id}/findings`)));
check('measurements', ok(await get(`/inspections/${inspection.id}/measurements`)));
check('photos', ok(await get(`/inspections/${inspection.id}/photos`)));
check('inspection history', ok(await get(`/inspections/${inspection.id}/history`)));

console.log('\nSamples and chain of custody');
const sample = await first('/samples?limit=1');
check('sample register', nonEmpty(await get('/samples?limit=5')));
check('sample card opens', ok(await get(`/samples/${sample.id}`)));
check('custody chain reads', ok(await get(`/samples/${sample.id}/custody`)));
check('sample history', ok(await get(`/samples/${sample.id}/history`)));
check('laboratories', nonEmpty(await get('/samples/laboratories')));

console.log('\nLaboratory');
check('analysis queue', ok(await get('/lab/requests?limit=5')));
check('dashboard', ok(await get('/lab/dashboard')));
check('test catalogue', nonEmpty(await get('/lab/tests')));
check('methods', nonEmpty(await get('/lab/methods')));
check('specifications', ok(await get('/lab/specifications')));
check('instruments', ok(await get('/lab/instruments')));
check('units', nonEmpty(await get('/lab/units')));
check('released results are asked for one sample at a time',
  ok(await get(`/lab/released?sampleId=${sample.id}`))
  && (await get('/lab/released')).status === 400);
const labRequest = await first('/lab/requests?limit=1');
if (labRequest) {
  check('analysis card opens', ok(await get(`/lab/requests/${labRequest.id}`)));
  check('analysis revisions', ok(await get(`/lab/requests/${labRequest.id}/revisions`)));
  check('analysis history', ok(await get(`/lab/requests/${labRequest.id}/history`)));
  check('analysis attachments', ok(await get(`/lab/requests/${labRequest.id}/attachments`)));
}

console.log('\nDocuments');
const reports = await get('/reports?limit=5');
const report = rows(reports.body)[0];
check('document register paginates', ok(reports) && typeof reports.body.total === 'number');
check('document card opens', ok(await get(`/reports/${report.id}`)));
check('document versions', ok(await get(`/reports/${report.id}/versions`)));
check('document history', ok(await get(`/reports/${report.id}/history`)));
check('document forms', nonEmpty(await get('/report-templates')));
check('register filters by type', ok(await get('/reports?reportType=inspection_report&limit=3')));
check('register filters by status', ok(await get('/reports?status=issued&limit=3')));
check('register searches', ok(await get('/reports?search=TR&limit=3')));

const issued = await first('/reports?status=issued&limit=1');
if (issued) {
  const file = await get(`/reports/${issued.id}/file`);
  check('an issued document downloads', file.status === 200 && file.body.byteLength > 1000,
    `${file.status}, ${file.body.byteLength ?? 0} bytes`);
  const verify = await fetch(`${API}/public/verify/${issued.verificationToken}`);
  check('and its QR verifies without a login', verify.status === 200);
}

console.log('\nFinance');
check('dashboard', ok(await get('/finance/dashboard')));
check('invoices', nonEmpty(await get('/finance/invoices')));
check('invoice summary', ok(await get('/finance/invoices-summary')));
check('expenses', ok(await get('/finance/expenses')));
check('expense summary', ok(await get('/finance/expenses-summary')));
check('fx rates', ok(await get('/finance/fx-rates')));
const invoice = await first('/finance/invoices');
if (invoice) {
  check('invoice card opens', ok(await get(`/finance/invoices/${invoice.id}`)));
  check('invoice payments', ok(await get(`/finance/invoices/${invoice.id}/payments`)));
  const pdf = await get(`/finance/invoices/${invoice.id}/pdf`);
  check('invoice prints', pdf.status === 200 && pdf.body.byteLength > 1000, String(pdf.status));
}

console.log('\nAssets, organisation, audit');
check('assets', ok(await get('/assets')));
check('organisation tree', ok(await get('/org')));
check('countries', ok(await get('/org/countries')));
check('branches', nonEmpty(await get('/branches')));
check('users', nonEmpty(await get('/users')));
check('roles', nonEmpty(await get('/admin/roles')));
check('permissions', nonEmpty(await get('/admin/permissions')));
check('audit log', nonEmpty(await get('/admin/audit?limit=5')));
check('commodities', nonEmpty(await get('/reference/commodities')));
check('ports', nonEmpty(await get('/reference/ports')));

console.log('\nExport and import');
const exportSections = rows((await get('/export/sections')).body.sections ?? []);
check('export sections are listed', exportSections.length > 0);
for (const section of exportSections) {
  check(`export ${section}`, (await get(`/export/${section}`)).status === 200);
}
const importSections = (await get('/import/sections')).body.sections ?? [];
check('import sections are listed', importSections.length > 0);
for (const section of importSections) {
  check(`import template ${section}`, (await get(`/import/${section}/template`)).status === 200);
}

console.log('\nHealth');
check('health/live', (await fetch(`${API}/health/live`)).status === 200);
check('health/ready', (await fetch(`${API}/health/ready`)).status === 200);

console.log(`\n==== ${passed} checks passed, ${failures.length} failed ====`);
if (failures.length) {
  for (const f of failures) console.log(`  FAILED: ${f}`);
  process.exit(1);
}
