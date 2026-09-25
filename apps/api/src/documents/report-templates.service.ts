import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuthUser,
  ReportTemplate,
  ReportTemplateDefinition,
  ReportType,
  REPORT_SECTIONS,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { DEFAULT_SECTIONS } from './templates/document';

const COLUMNS = `
  t.id, t.code, t.name, t.report_type AS "reportType", t.branch_id AS "branchId", b.code AS "branchCode",
  t.language, t.version, t.is_active AS "isActive", t.definition, t.description,
  t.effective_from AS "effectiveFrom", t.retired_at AS "retiredAt",
  t.created_at AS "createdAt", t.updated_at AS "updatedAt"`;

const FROM = 'report_templates t LEFT JOIN branches b ON b.id = t.branch_id';

export interface TemplateInput {
  code: string;
  name: string;
  reportType: ReportType;
  branchId?: string | null;
  language?: string | null;
  description?: string | null;
  definition?: ReportTemplateDefinition;
}

/**
 * The forms documents are printed on.
 *
 * A template is a list of sections and their options rather than code, so a new document type
 * is a row here and not another screen. The version is raised by the database when anything
 * substantive changes, and every issued revision records the version it was printed with — a
 * template edited next year cannot alter a certificate printed this year.
 */
@Injectable()
export class ReportTemplatesService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  list(user: AuthUser, f: { reportType?: ReportType; includeInactive?: boolean } = {}): Promise<ReportTemplate[]> {
    return this.db.tx(user, (tx) =>
      tx.many<ReportTemplate>(
        `SELECT ${COLUMNS} FROM ${FROM}
         WHERE ($1::report_kind IS NULL OR t.report_type = $1::report_kind)
           AND ($2::boolean IS TRUE OR t.is_active)
         ORDER BY t.report_type, t.code`,
        [f.reportType ?? null, f.includeInactive ?? false],
      ),
    );
  }

  byId(tx: Tx, id: string): Promise<ReportTemplate | null> {
    return tx.one<ReportTemplate>(`SELECT ${COLUMNS} FROM ${FROM} WHERE t.id = $1`, [id]);
  }

  /**
   * The template a document should use: the one asked for, or the best fit for its type and
   * office — a form the office prints itself wins over the group's, and an active one wins
   * over a retired one.
   */
  async resolve(
    tx: Tx,
    templateId: string | null,
    reportType: ReportType,
    branchId: string,
  ): Promise<ReportTemplate | null> {
    if (templateId) {
      const chosen = await this.byId(tx, templateId);
      if (!chosen) throw new NotFoundException('Template not found');
      if (chosen.reportType !== reportType) {
        throw new BadRequestException(
          `That template prints a ${chosen.reportType.replace(/_/g, ' ')}, not a ${reportType.replace(/_/g, ' ')}`,
        );
      }
      return chosen;
    }
    return tx.one<ReportTemplate>(
      `SELECT ${COLUMNS} FROM ${FROM}
       WHERE t.report_type = $1::report_kind AND t.is_active AND t.retired_at IS NULL
         AND (t.branch_id IS NULL OR t.branch_id = $2::uuid)
       ORDER BY (t.branch_id = $2::uuid) DESC, t.effective_from DESC, t.version DESC
       LIMIT 1`,
      [reportType, branchId],
    );
  }

  create(user: AuthUser, input: TemplateInput): Promise<ReportTemplate> {
    const definition = this.validate(input.definition ?? { sections: DEFAULT_SECTIONS[input.reportType] });
    return this.db.tx(user, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `INSERT INTO report_templates (code, name, report_type, branch_id, language, description,
                                       definition, created_by)
         VALUES ($1, $2, $3::report_kind, $4, $5, $6, $7::jsonb, $8) RETURNING id`,
        [input.code.trim(), input.name.trim(), input.reportType, input.branchId ?? null,
         input.language ?? null, input.description ?? null, JSON.stringify(definition), user.id],
      );
      await this.audit.record(tx, user, {
        action: 'report.template_created',
        entityType: 'report_template',
        entityId: row!.id,
        entityLabel: input.code,
        after: { reportType: input.reportType, sections: definition.sections.length },
      });
      return (await this.byId(tx, row!.id))!;
    });
  }

  update(user: AuthUser, id: string, patch: Partial<TemplateInput> & { isActive?: boolean }): Promise<ReportTemplate> {
    const definition = patch.definition ? this.validate(patch.definition) : null;
    return this.db.tx(user, async (tx) => {
      const before = await this.byId(tx, id);
      if (!before) throw new NotFoundException('Template not found');
      await tx.exec(
        `UPDATE report_templates
         SET name = COALESCE($2, name), language = COALESCE($3, language),
             description = COALESCE($4, description),
             definition = COALESCE($5::jsonb, definition),
             is_active = COALESCE($6, is_active),
             retired_at = CASE WHEN $6 IS FALSE THEN now() WHEN $6 IS TRUE THEN NULL ELSE retired_at END
         WHERE id = $1`,
        [id, patch.name?.trim() ?? null, patch.language ?? null, patch.description ?? null,
         definition ? JSON.stringify(definition) : null, patch.isActive ?? null],
      );
      const after = (await this.byId(tx, id))!;
      await this.audit.record(tx, user, {
        action: after.version > before.version ? 'report.template_versioned' : 'report.template_updated',
        entityType: 'report_template',
        entityId: id,
        entityLabel: after.code,
        before: { version: before.version },
        after: { version: after.version },
      });
      return after;
    });
  }

  /** A template that names a section the renderer does not know would print nothing, silently. */
  private validate(definition: ReportTemplateDefinition): ReportTemplateDefinition {
    if (!definition.sections?.length) throw new BadRequestException('A template needs at least one section');
    for (const s of definition.sections) {
      if (!REPORT_SECTIONS.includes(s.section)) {
        throw new BadRequestException(
          `Unknown section "${s.section}". Known sections: ${REPORT_SECTIONS.join(', ')}`,
        );
      }
    }
    return definition;
  }
}
