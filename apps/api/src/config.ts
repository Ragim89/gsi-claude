function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

/** '15m' / '7d' / '3600' → seconds. */
function ttlSeconds(v: string): number {
  const m = /^(\d+)\s*([smhd]?)$/.exec(v.trim());
  if (!m) throw new Error(`Invalid TTL "${v}"`);
  const mult = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * mult;
}

function secret(name: string): string {
  // Dev fallbacks keep `npm run dev` friction-free; production must set real secrets.
  return isProd ? env(name) : env(name, `dev-only-${name.toLowerCase()}`);
}

export const config = {
  get port() {
    return Number(process.env.PORT ?? 3000);
  },
  /** Connection as the non-owner `gsi_app` role — subject to Row-Level Security. */
  get databaseUrl() {
    return env('DATABASE_URL', 'postgres://gsi_app:gsi_app@localhost:5432/gsi');
  },
  /** Owner / superuser connection — migrations and seeds only. */
  get databaseOwnerUrl() {
    return env('DATABASE_OWNER_URL', 'postgres://gsi:gsi@localhost:5432/gsi');
  },
  get appDbPassword() {
    return env('APP_DB_PASSWORD', 'gsi_app');
  },
  jwt: {
    get accessSecret() {
      return secret('JWT_ACCESS_SECRET');
    },
    get refreshSecret() {
      return secret('JWT_REFRESH_SECRET');
    },
    accessTtlSeconds: ttlSeconds(process.env.JWT_ACCESS_TTL ?? '15m'),
    refreshTtlSeconds: ttlSeconds(process.env.JWT_REFRESH_TTL ?? '7d'),
  },
  s3: {
    get endpoint() {
      return env('S3_ENDPOINT', 'http://localhost:9000');
    },
    /** Endpoint used when presigning URLs for browsers (differs from the in-cluster one in docker). */
    get publicEndpoint() {
      return process.env.S3_PUBLIC_ENDPOINT || this.endpoint;
    },
    region: process.env.S3_REGION ?? 'us-east-1',
    get accessKey() {
      return env('S3_ACCESS_KEY', 'minioadmin');
    },
    get secretKey() {
      return env('S3_SECRET_KEY', 'minioadmin');
    },
    get bucket() {
      return env('S3_BUCKET', 'gsi-media');
    },
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
    presignTtlSeconds: Number(process.env.S3_PRESIGN_TTL ?? 900),
  },
  /** Base URL of the web app; used for the QR verification link printed on reports. */
  get publicWebUrl() {
    return (process.env.PUBLIC_WEB_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  },
  /**
   * Group consolidation currency for the finance dashboard.
   * ASSUMPTION: EUR (docs/01 suggests "EUR или USD"; GSI has not confirmed).
   */
  consolidationCurrency: (process.env.CONSOLIDATION_CURRENCY ?? 'EUR').toUpperCase(),
  chromiumPath: process.env.PUPPETEER_EXECUTABLE_PATH,
  /** Runtime environment name, used for logging format and error verbosity. */
  get env() {
    return process.env.NODE_ENV ?? 'development';
  },
  get isProduction() {
    return process.env.NODE_ENV === 'production';
  },
  rateLimit: {
    /** Only ever set in the test compose service: throttling makes a test suite flaky. */
    disabled: process.env.RATE_LIMIT_DISABLED === 'true',
    /** General API budget per client per minute. */
    windowSeconds: Number(process.env.RATE_LIMIT_WINDOW ?? 60),
    limit: Number(process.env.RATE_LIMIT_MAX ?? 300),
    /** Sign-in attempts per client per window — the brute-force budget. */
    authLimit: Number(process.env.RATE_LIMIT_AUTH_MAX ?? 10),
  },
  /** JSON logs in production (for log shippers), human-readable ones in development. */
  get logJson() {
    return (process.env.LOG_JSON ?? (this.isProduction ? 'true' : 'false')) === 'true';
  },
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024,
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:8080').split(','),
  /**
   * Outbound e-mail (PHASE 10). 'console' — the default — logs the message instead of sending
   * it, so a fresh checkout never silently mails anyone; set EMAIL_PROVIDER=smtp with real
   * credentials to actually deliver. SMTP rather than one vendor's SDK is the point: any
   * provider (SES, SendGrid, Mailgun, a corporate relay) speaks it, so this adapter is never
   * tied to one poster.
   */
  email: {
    provider: (process.env.EMAIL_PROVIDER ?? 'console').toLowerCase(),
    from: process.env.EMAIL_FROM ?? 'no-reply@gsi.local',
    smtp: {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: (process.env.SMTP_SECURE ?? 'false') === 'true',
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  },
};

/**
 * Fail fast on the mistake that is easy to make once and expensive to find later: shipping a
 * container built for `docker compose up` — dev passwords, an HTTP public URL, MinIO's own
 * `minioadmin` — straight into production. Every value here has a working, harmless default in
 * development; in production none of them may keep it. Called once at boot, before the app opens
 * a port, so a misconfigured deploy dies in the orchestrator's crash loop instead of serving
 * traffic with `gsi_app` / `gsi_app` as its database password.
 */
export function assertProductionSafe(): void {
  if (!config.isProduction) return;

  const problems: string[] = [];
  const insecure = (name: string, value: string, bad: string | RegExp) => {
    const isBad = typeof bad === 'string' ? value === bad : bad.test(value);
    if (isBad) problems.push(`${name} still has its development value`);
  };

  insecure('DATABASE_URL', config.databaseUrl, /:\/\/gsi_app:gsi_app@|localhost/);
  insecure('DATABASE_OWNER_URL', config.databaseOwnerUrl, /:\/\/gsi:gsi@|localhost/);
  insecure('APP_DB_PASSWORD', config.appDbPassword, 'gsi_app');
  insecure('S3_ACCESS_KEY', config.s3.accessKey, 'minioadmin');
  insecure('S3_SECRET_KEY', config.s3.secretKey, 'minioadmin');
  if (process.env.SEED_PASSWORD === 'ChangeMe123!' && process.env.SEED_DEMO === 'true') {
    problems.push('SEED_PASSWORD still has its development value');
  }
  if (!/^https:\/\//.test(config.publicWebUrl)) {
    problems.push(`PUBLIC_WEB_URL must be an https:// URL in production (got "${config.publicWebUrl}")`);
  }
  if (config.corsOrigins.some((o) => /localhost|127\.0\.0\.1/.test(o))) {
    problems.push('CORS_ORIGINS still lists a localhost origin');
  }
  if (process.env.SEED_ON_START === 'true' && process.env.SEED_DEMO !== 'true') {
    // seed.ts itself refuses demo data without SEED_DEMO=true; this only guards the reference
    // data path (branches, catalogues), which is meant to run once and is safe to repeat, but a
    // long-lived container should not keep re-running it on every restart.
    // eslint-disable-next-line no-console
    console.warn('WARNING: SEED_ON_START=true in production — reference data seeding runs on every boot');
  }

  if (problems.length) {
    throw new Error(
      `Refusing to start in production with insecure configuration:\n  - ${problems.join('\n  - ')}`,
    );
  }
}
