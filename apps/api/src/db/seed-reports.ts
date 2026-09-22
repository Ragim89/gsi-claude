/**
 * Issues real PDF reports for a sample of the seeded approved jobs, so the demo has a
 * populated document register and a meaningful "job → report" cycle-time KPI.
 *
 * Runs after the Nest app is up (it needs the report renderer), never in production
 * unless SEED_DEMO is explicitly set. Each report is rendered and stored exactly like a
 * supervisor-issued one — no fabricated rows.
 */
import { INestApplicationContext, Logger } from '@nestjs/common';
import type { AuthUser } from '@gsi/shared-types';
import { DbService } from './db.service';
import { ReportsService } from '../documents/reports.service';

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

  const jobs = await db.tx(user, (tx) =>
    tx.many<{ id: string }>(
      `SELECT j.id FROM inspection_jobs j
       WHERE j.status = 'approved' AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.job_id = j.id)
       ORDER BY j.approved_at DESC
       LIMIT $1`,
      [limit],
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
