import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthUser, JurisdictionProfile, JurisdictionProfileConfig } from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../common/audit.service';

const PROFILE_COLUMNS = `
  id, country_code AS "countryCode", profile_version AS "profileVersion", status,
  to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom", to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo",
  default_document_currency AS "defaultDocumentCurrency", config, source_notes AS "sourceNotes",
  created_at AS "createdAt"`;

export interface CreateJurisdictionProfileInput {
  countryCode: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  defaultDocumentCurrency: string;
  config: JurisdictionProfileConfig;
  sourceNotes?: string | null;
}

/**
 * Versioned jurisdiction/tax rules (migration 028). A row is written once and never updated —
 * gsi_app has SELECT/INSERT only on jurisdiction_profiles, exactly like audit_logs — so "adding
 * a country" or "a law changes" is always a new row with a later effectiveFrom, never an edit
 * of one an invoice may already have used.
 */
@Injectable()
export class JurisdictionProfileService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  list(user: AuthUser, countryCode?: string) {
    return this.db.tx(user, (tx) =>
      tx.many<JurisdictionProfile>(
        `SELECT ${PROFILE_COLUMNS} FROM jurisdiction_profiles
         WHERE ($1::char(2) IS NULL OR country_code = $1)
         ORDER BY country_code, profile_version DESC`,
        [countryCode ? countryCode.toUpperCase() : null],
      ),
    );
  }

  /** Every distinct country code known to the org (from countries), each with whether it has a
   *  verified profile right now — what the admin screen and "add a country" flow both need. */
  countries(user: AuthUser) {
    return this.db.tx(user, (tx) =>
      tx.many<{ code: string; name: string; hasVerifiedProfile: boolean; latestVersion: number | null }>(
        `SELECT c.code, min(c.name) AS name,
                bool_or(p.status = 'verified' AND p.effective_from <= current_date) AS "hasVerifiedProfile",
                max(p.profile_version) FILTER (WHERE p.status = 'verified') AS "latestVersion"
         FROM countries c
         LEFT JOIN jurisdiction_profiles p ON p.country_code = c.code
         GROUP BY c.code ORDER BY c.code`,
      ),
    );
  }

  /** The profile in force on a date, or null when this country has no verified rule pack yet
   *  ("compliance_config_required" — see docs/FISCAL_COMPLIANCE.md). Never falls back to
   *  another country's rules. */
  async resolve(tx: Tx, countryCode: string, onDate: string): Promise<JurisdictionProfile | null> {
    return tx.one<JurisdictionProfile>(
      `SELECT ${PROFILE_COLUMNS} FROM jurisdiction_profiles
       WHERE country_code = $1 AND status = 'verified' AND effective_from <= $2::date
       ORDER BY effective_from DESC LIMIT 1`,
      [countryCode.toUpperCase(), onDate],
    );
  }

  createVersion(user: AuthUser, input: CreateJurisdictionProfileInput) {
    const countryCode = input.countryCode.toUpperCase();
    return this.db.tx(user, async (tx) => {
      const latest = await tx.one<{ v: number }>(
        `SELECT COALESCE(max(profile_version), 0) AS v FROM jurisdiction_profiles WHERE country_code = $1`,
        [countryCode],
      );
      const nextVersion = (latest?.v ?? 0) + 1;
      const prior = nextVersion > 1
        ? await tx.one<{ effective_from: string }>(
            `SELECT to_char(effective_from, 'YYYY-MM-DD') AS effective_from FROM jurisdiction_profiles
             WHERE country_code = $1 ORDER BY effective_from DESC LIMIT 1`,
            [countryCode],
          )
        : null;
      if (prior && input.effectiveFrom <= prior.effective_from) {
        throw new BadRequestException(
          `effectiveFrom must be after the current version's ${prior.effective_from} — a new version can only take over from a later date, never rewrite when the previous one applied`,
        );
      }
      const row = await tx.one<{ id: string }>(
        `INSERT INTO jurisdiction_profiles
           (country_code, profile_version, status, effective_from, effective_to,
            default_document_currency, config, source_notes, created_by)
         VALUES ($1, $2, 'verified', $3::date, $4::date, $5, $6::jsonb, $7, $8)
         RETURNING id`,
        [
          countryCode, nextVersion, input.effectiveFrom, input.effectiveTo ?? null,
          input.defaultDocumentCurrency.toUpperCase(), JSON.stringify(input.config),
          input.sourceNotes ?? null, user.id,
        ],
      );
      await this.audit.record(tx, user, {
        action: 'fiscal_profile.version_created',
        entityType: 'jurisdiction_profile',
        entityId: row!.id,
        entityLabel: `${countryCode} v${nextVersion}`,
        after: { countryCode, profileVersion: nextVersion, effectiveFrom: input.effectiveFrom },
      });
      return tx.one<JurisdictionProfile>(`SELECT ${PROFILE_COLUMNS} FROM jurisdiction_profiles WHERE id = $1`, [row!.id]);
    });
  }
}
