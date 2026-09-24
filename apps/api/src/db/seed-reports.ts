/**
 * Issues real PDF reports for a sample of the seeded approved jobs, so the demo has a
 * populated document register and a meaningful "job → report" cycle-time KPI.
 *
 * Runs after the Nest app is up (it needs the report renderer), never in production
 * unless SEED_DEMO is explicitly set. Each report is rendered and stored exactly like a
 * supervisor-issued one — no fabricated rows.
 *
 * `limit` is how many demo reports the register should end up holding, not how many to add.
 * It used to mean the latter, and since the demo has 956 approved jobs, every restart quietly
 * issued another forty until they all had one. A seed that grows the data each time it runs
 * is not a seed.
 */
import { INestApplicationContext, Logger } from '@nestjs/common';
import type { AuthUser } from '@gsi/shared-types';
import { DbService } from './db.service';
import { ReportsService } from '../documents/reports.service';

/**
 * How many reports this run should still issue to reach the target — never a negative number,
 * and zero once the register already holds enough. Separate from the seed itself so the rule
 * can be asserted without rendering a PDF.
 */
export function stillNeeded(existing: number, target: number): number {
  return Math.max(0, target - existing);
}

export async function seedReports(app: INestApplicationContext, limit: number): Promise<void> {
  const logger = new Logger('SeedReports');
  const db = app.get(DbService);
  const reports = app.get(ReportsService);

  // Without a security context RLS hides every user row, so look the seed admin up through
  // the SECURITY DEFINER function that login uses.
  const admin = await db.tx(null, (tx) =>
    tx.one<{ id: string; branch_id: string }>(`SELECT id, branch_id FROM auth_find_user($1, NULL)`, [
      process.env.SEED_ADMIN_EMAIL ?? 'admin@gsi.local',
    ]),
  );
  if (!admin) {
    logger.warn('seed admin not found; skipping demo reports');
    return;
  }
  const user: AuthUser = {
    id: admin.id,
    branchId: admin.branch_id,
    role: 'admin',
    email: 'seed',
    fullName: 'System Administrator',
    locale: 'en',
  };

  const existing = await db.tx(user, (tx) =>
    tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM reports`),
  );
  const wanted = stillNeeded(existing?.n ?? 0, limit);
  if (!wanted) {
    logger.log(`demo reports already present (${existing?.n ?? 0}); nothing to issue`);
    return;
  }

  const jobs = await db.tx(user, (tx) =>
    tx.many<{ id: string }>(
      `SELECT j.id FROM inspection_jobs j
       WHERE j.status = 'approved' AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.job_id = j.id)
       ORDER BY j.approved_at DESC
       LIMIT $1`,
      [wanted],
    ),
  );
  if (!jobs.length) return;

  let issued = 0;
  for (const job of jobs) {
    try {
      await db.tx(user, (tx) => reports.issueForJob(tx, user, job.id));
      issued++;
    } catch (err) {
      logger.warn(`could not issue a report for job ${job.id}: ${(err as Error).message}`);
    }
  }
  logger.log(`issued ${issued} demo reports`);
}
