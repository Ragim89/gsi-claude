import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuthUser,
  LabInstrument,
  LabResultType,
  LabTest,
  LabUnit,
  LocalizedText,
  TestMethod,
  TestPanel,
  TestSpecification,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { buildSet } from '../common/sql';
import { AuditService } from '../common/audit.service';

const TEST_COLUMNS = `
  t.id, t.code, t.name, t.category, t.description, t.default_unit AS "defaultUnit",
  t.result_type AS "resultType", t.is_active AS "isActive", t.sort_order AS "sortOrder",
  (SELECT count(*)::int FROM test_methods m WHERE m.lab_test_id = t.id AND m.is_active) AS "methodCount"`;

const METHOD_COLUMNS = `
  m.id, m.lab_test_id AS "labTestId", t.code AS "testCode", t.name AS "testName",
  m.code, m.name, m.standard_reference AS "standardReference", m.description,
  m.default_unit AS "defaultUnit", m.detection_limit::float8 AS "detectionLimit",
  m.quantification_limit::float8 AS "quantificationLimit", m.accreditation_scope AS "accreditationScope",
  m.version, m.effective_from AS "effectiveFrom", m.retired_at AS "retiredAt", m.is_active AS "isActive"`;

const SPEC_COLUMNS = `
  s.id, s.lab_test_id AS "labTestId", t.code AS "testCode", t.name AS "testName",
  s.test_method_id AS "testMethodId", m.code AS "methodCode",
  s.commodity_id AS "commodityId", cm.name AS "commodityName",
  s.client_id AS "clientId", c.name AS "clientName",
  s.contract_id AS "contractId", ct.contract_no AS "contractRef",
  s.min_value::float8 AS "minValue", s.max_value::float8 AS "maxValue",
  s.target_value::float8 AS "targetValue", s.unit,
  s.qualitative_requirement AS "qualitativeRequirement", s.notes,
  s.effective_from AS "effectiveFrom", s.effective_to AS "effectiveTo", s.is_active AS "isActive",
  CASE WHEN s.contract_id IS NOT NULL THEN 'contract'
       WHEN s.client_id IS NOT NULL THEN 'client'
       WHEN s.commodity_id IS NOT NULL THEN 'commodity'
       ELSE 'default' END AS scope`;

const SPEC_FROM = `
  test_specifications s
  JOIN lab_tests t ON t.id = s.lab_test_id
  LEFT JOIN test_methods m ON m.id = s.test_method_id
  LEFT JOIN commodities cm ON cm.id = s.commodity_id
  LEFT JOIN clients c ON c.id = s.client_id
  LEFT JOIN contracts ct ON ct.id = s.contract_id`;

const INSTRUMENT_COLUMNS = `
  i.id, i.laboratory_id AS "laboratoryId", l.name AS "laboratoryName", i.code, i.name,
  i.manufacturer, i.model, i.serial_number AS "serialNumber", i.status,
  i.calibration_due_at AS "calibrationDueAt", i.notes,
  (i.calibration_due_at IS NOT NULL AND i.calibration_due_at < current_date) AS "calibrationOverdue"`;

/**
 * The laboratory's reference data: what it can measure, how, to what limits and with what.
 *
 * None of this is invented by the application. The test catalogue is built in migration 015
 * from `commodities.lab_methods`, which the offices have maintained since the reference data
 * was first loaded; methods, specifications and instruments are entered by the laboratory,
 * because only the laboratory knows which standard it works to and what is on its bench.
 */
@Injectable()
export class LabCatalogueService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  units(user: AuthUser): Promise<LabUnit[]> {
    return this.db.tx(user, (tx) =>
      tx.many<LabUnit>('SELECT code, name, kind FROM lab_units ORDER BY sort_order, code'),
    );
  }

  // ---- Tests -----------------------------------------------------------------------------

  tests(user: AuthUser, includeInactive = false): Promise<LabTest[]> {
    return this.db.tx(user, (tx) =>
      tx.many<LabTest>(
        `SELECT ${TEST_COLUMNS} FROM lab_tests t
         WHERE ($1::boolean IS TRUE OR t.is_active)
         ORDER BY t.is_active DESC, t.category, t.sort_order, t.code`,
        [includeInactive],
      ),
    );
  }

  createTest(user: AuthUser, input: TestInput) {
    return this.db.tx(user, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `INSERT INTO lab_tests (code, name, category, description, default_unit, result_type, sort_order, created_by)
         VALUES (lower($1), $2::jsonb, COALESCE($3, 'general'), $4, $5, COALESCE($6::lab_result_type, 'numeric'),
                 COALESCE($7, 100), $8)
         RETURNING id`,
        [input.code.trim(), JSON.stringify(input.name), input.category ?? null, input.description ?? null,
         input.defaultUnit ?? null, input.resultType ?? null, input.sortOrder ?? null, user.id],
      );
      await this.audit.record(tx, user, {
        action: 'lab.test.created',
        entityType: 'lab_test',
        entityId: row!.id,
        entityLabel: input.code,
        branchId: user.branchId,
        after: { code: input.code, resultType: input.resultType ?? 'numeric' },
      });
      return this.testIn(tx, row!.id);
    });
  }

  updateTest(user: AuthUser, id: string, input: Partial<TestInput> & { isActive?: boolean }) {
    const { sql, params } = buildSet(
      { ...input, name: input.name ? JSON.stringify(input.name) : undefined } as Record<string, unknown>,
      {
        name: 'name', category: 'category', description: 'description', defaultUnit: 'default_unit',
        resultType: 'result_type', sortOrder: 'sort_order', isActive: 'is_active',
      },
      2,
    );
    if (!sql) throw new BadRequestException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const n = await tx.exec(`UPDATE lab_tests SET ${sql} WHERE id = $1`, [id, ...params]);
      if (!n) throw new NotFoundException('Test not found');
      await this.audit.record(tx, user, {
        action: 'lab.test.updated',
        entityType: 'lab_test',
        entityId: id,
        entityLabel: '',
        branchId: user.branchId,
        after: input as Record<string, unknown>,
      });
      return this.testIn(tx, id);
    });
  }

  // ---- Methods ---------------------------------------------------------------------------

  methods(user: AuthUser, f: { labTestId?: string; includeInactive?: boolean } = {}): Promise<TestMethod[]> {
    return this.db.tx(user, (tx) =>
      tx.many<TestMethod>(
        `SELECT ${METHOD_COLUMNS} FROM test_methods m JOIN lab_tests t ON t.id = m.lab_test_id
         WHERE ($1::uuid IS NULL OR m.lab_test_id = $1::uuid)
           AND ($2::boolean IS TRUE OR m.is_active)
         ORDER BY t.sort_order, t.code, m.code`,
        [f.labTestId ?? null, f.includeInactive ?? false],
      ),
    );
  }

  createMethod(user: AuthUser, input: MethodInput) {
    return this.db.tx(user, async (tx) => {
      const test = await tx.one<{ id: string; code: string }>('SELECT id, code FROM lab_tests WHERE id = $1', [
        input.labTestId,
      ]);
      if (!test) throw new BadRequestException('Unknown test');

      const row = await tx.one<{ id: string }>(
        `INSERT INTO test_methods (lab_test_id, code, name, standard_reference, description, default_unit,
                                   detection_limit, quantification_limit, accreditation_scope,
                                   effective_from, created_by)
         VALUES ($1, upper($2), $3, $4, $5, $6, $7::numeric, $8::numeric, $9,
                 COALESCE($10::date, current_date), $11)
         RETURNING id`,
        [input.labTestId, input.code.trim(), input.name.trim(), input.standardReference ?? null,
         input.description ?? null, input.defaultUnit ?? null, input.detectionLimit ?? null,
         input.quantificationLimit ?? null, input.accreditationScope ?? null,
         input.effectiveFrom ?? null, user.id],
      );
      await this.audit.record(tx, user, {
        action: 'lab.method.created',
        entityType: 'test_method',
        entityId: row!.id,
        entityLabel: input.code,
        branchId: user.branchId,
        after: { test: test.code, standardReference: input.standardReference ?? null },
      });
      return this.methodIn(tx, row!.id);
    });
  }

  /**
   * Editing a method bumps its version — by trigger, so nothing depends on this service
   * remembering to. Results already entered keep the snapshot they were taken with.
   */
  updateMethod(user: AuthUser, id: string, input: Partial<MethodInput> & { isActive?: boolean; retiredAt?: string | null }) {
    const { sql, params } = buildSet(input as Record<string, unknown>, {
      name: 'name', standardReference: 'standard_reference', description: 'description',
      defaultUnit: 'default_unit', detectionLimit: 'detection_limit',
      quantificationLimit: 'quantification_limit', accreditationScope: 'accreditation_scope',
      effectiveFrom: 'effective_from', retiredAt: 'retired_at', isActive: 'is_active',
    }, 2);
    if (!sql) throw new BadRequestException('Nothing to update');

    return this.db.tx(user, async (tx) => {
      const before = await tx.one<{ version: number; code: string }>(
        'SELECT version, code FROM test_methods WHERE id = $1',
        [id],
      );
      if (!before) throw new NotFoundException('Method not found');
      await tx.exec(`UPDATE test_methods SET ${sql} WHERE id = $1`, [id, ...params]);
      const after = await this.methodIn(tx, id);
      await this.audit.record(tx, user, {
        action: 'lab.method.updated',
        entityType: 'test_method',
        entityId: id,
        entityLabel: before.code,
        branchId: user.branchId,
        before: { version: before.version },
        after: { version: after!.version, ...(input as Record<string, unknown>) },
      });
      return after;
    });
  }

  // ---- Specifications --------------------------------------------------------------------

  specifications(
    user: AuthUser,
    f: { labTestId?: string; commodityId?: string; clientId?: string; contractId?: string; includeInactive?: boolean } = {},
  ): Promise<TestSpecification[]> {
    return this.db.tx(user, (tx) =>
      tx.many<TestSpecification>(
        `SELECT ${SPEC_COLUMNS} FROM ${SPEC_FROM}
         WHERE ($1::uuid IS NULL OR s.lab_test_id = $1::uuid)
           AND ($2::uuid IS NULL OR s.commodity_id = $2::uuid)
           AND ($3::uuid IS NULL OR s.client_id = $3::uuid)
           AND ($4::uuid IS NULL OR s.contract_id = $4::uuid)
           AND ($5::boolean IS TRUE OR s.is_active)
         ORDER BY t.sort_order, t.code,
                  (s.contract_id IS NOT NULL) DESC, (s.client_id IS NOT NULL) DESC,
                  (s.commodity_id IS NOT NULL) DESC, s.effective_from DESC`,
        [f.labTestId ?? null, f.commodityId ?? null, f.clientId ?? null, f.contractId ?? null,
         f.includeInactive ?? false],
      ),
    );
  }

  createSpecification(user: AuthUser, input: SpecificationInput) {
    if (input.minValue == null && input.maxValue == null && input.targetValue == null
        && !input.qualitativeRequirement?.trim()) {
      throw new BadRequestException('A specification needs at least one limit or requirement');
    }
    return this.db.tx(user, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `INSERT INTO test_specifications (lab_test_id, test_method_id, commodity_id, client_id, contract_id,
                                          min_value, max_value, target_value, unit, qualitative_requirement,
                                          notes, effective_from, effective_to, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::numeric, $7::numeric, $8::numeric,
                 $9, $10, $11, COALESCE($12::date, current_date), $13::date, $14::uuid)
         RETURNING id`,
        [input.labTestId, input.testMethodId ?? null, input.commodityId ?? null, input.clientId ?? null,
         input.contractId ?? null, input.minValue ?? null, input.maxValue ?? null, input.targetValue ?? null,
         input.unit ?? null, input.qualitativeRequirement ?? null, input.notes ?? null,
         input.effectiveFrom ?? null, input.effectiveTo ?? null, user.id],
      );
      await this.audit.record(tx, user, {
        action: 'lab.specification.created',
        entityType: 'test_specification',
        entityId: row!.id,
        entityLabel: '',
        branchId: user.branchId,
        after: input as unknown as Record<string, unknown>,
      });
      return this.specificationIn(tx, row!.id);
    });
  }

  updateSpecification(user: AuthUser, id: string, input: Partial<SpecificationInput> & { isActive?: boolean }) {
    const { sql, params } = buildSet(input as Record<string, unknown>, {
      minValue: 'min_value', maxValue: 'max_value', targetValue: 'target_value', unit: 'unit',
      qualitativeRequirement: 'qualitative_requirement', notes: 'notes',
      effectiveFrom: 'effective_from', effectiveTo: 'effective_to', isActive: 'is_active',
    }, 2);
    if (!sql) throw new BadRequestException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const n = await tx.exec(`UPDATE test_specifications SET ${sql} WHERE id = $1`, [id, ...params]);
      if (!n) throw new NotFoundException('Specification not found');
      await this.audit.record(tx, user, {
        action: 'lab.specification.updated',
        entityType: 'test_specification',
        entityId: id,
        entityLabel: '',
        branchId: user.branchId,
        after: input as Record<string, unknown>,
      });
      return this.specificationIn(tx, id);
    });
  }

  // ---- Instruments -----------------------------------------------------------------------

  instruments(user: AuthUser, laboratoryId?: string): Promise<LabInstrument[]> {
    return this.db.tx(user, (tx) =>
      tx.many<LabInstrument>(
        `SELECT ${INSTRUMENT_COLUMNS} FROM lab_instruments i JOIN laboratories l ON l.id = i.laboratory_id
         WHERE ($1::uuid IS NULL OR i.laboratory_id = $1::uuid)
         ORDER BY l.name, i.code`,
        [laboratoryId ?? null],
      ),
    );
  }

  createInstrument(user: AuthUser, input: InstrumentInput) {
    return this.db.tx(user, async (tx) => {
      const lab = await tx.one<{ id: string }>('SELECT id FROM laboratories WHERE id = $1', [input.laboratoryId]);
      if (!lab) throw new BadRequestException('Unknown laboratory');
      const row = await tx.one<{ id: string }>(
        `INSERT INTO lab_instruments (laboratory_id, code, name, manufacturer, model, serial_number,
                                      calibration_due_at, notes, created_by)
         VALUES ($1, upper($2), $3, $4, $5, $6, $7::date, $8, $9)
         RETURNING id`,
        [input.laboratoryId, input.code.trim(), input.name.trim(), input.manufacturer ?? null,
         input.model ?? null, input.serialNumber ?? null, input.calibrationDueAt ?? null,
         input.notes ?? null, user.id],
      );
      await this.audit.record(tx, user, {
        action: 'lab.instrument.created',
        entityType: 'lab_instrument',
        entityId: row!.id,
        entityLabel: input.code,
        branchId: user.branchId,
        after: { code: input.code, name: input.name },
      });
      return this.instrumentIn(tx, row!.id);
    });
  }

  updateInstrument(user: AuthUser, id: string, input: Partial<InstrumentInput> & { status?: string }) {
    const { sql, params } = buildSet(input as Record<string, unknown>, {
      name: 'name', manufacturer: 'manufacturer', model: 'model', serialNumber: 'serial_number',
      calibrationDueAt: 'calibration_due_at', notes: 'notes', status: 'status',
    }, 2);
    if (!sql) throw new BadRequestException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const n = await tx.exec(
        `UPDATE lab_instruments SET ${sql} WHERE id = $1`,
        [id, ...params],
      );
      if (!n) throw new NotFoundException('Instrument not found');
      await this.audit.record(tx, user, {
        action: 'lab.instrument.updated',
        entityType: 'lab_instrument',
        entityId: id,
        entityLabel: '',
        branchId: user.branchId,
        after: input as Record<string, unknown>,
      });
      return this.instrumentIn(tx, id);
    });
  }

  // ---- Panels ----------------------------------------------------------------------------

  /**
   * The standard panel for a commodity: the analyses recorded against it in
   * `commodities.lab_methods`, resolved to catalogue entries and to the method the laboratory
   * would actually use. There is no panel table — that list has been the panel all along.
   */
  panel(user: AuthUser, commodityId: string, sampleId?: string): Promise<TestPanel> {
    return this.db.tx(user, async (tx) => {
      const commodity = await tx.one<{ id: string; name: LocalizedText; lab_methods: string[] }>(
        'SELECT id, name, lab_methods FROM commodities WHERE id = $1',
        [commodityId],
      );
      if (!commodity) throw new NotFoundException('Commodity not found');

      const tests = await tx.many<TestPanel['tests'][number]>(
        `SELECT t.id AS "labTestId", t.code, t.name, t.result_type AS "resultType",
                t.default_unit AS "defaultUnit",
                m.id AS "testMethodId", m.code AS "methodCode",
                ($2::uuid IS NOT NULL AND EXISTS (
                   SELECT 1 FROM test_requests r
                   WHERE r.sample_id = $2::uuid AND r.lab_test_id = t.id
                     AND r.status NOT IN ('cancelled', 'rejected')
                 )) AS "alreadyRequested"
         FROM unnest($1::text[]) WITH ORDINALITY AS wanted(code, ord)
         JOIN lab_tests t ON t.code = wanted.code AND t.is_active
         LEFT JOIN LATERAL (
           SELECT m.id, m.code FROM test_methods m
           WHERE m.lab_test_id = t.id AND m.is_active AND m.retired_at IS NULL
           ORDER BY m.effective_from DESC, m.code
           LIMIT 1
         ) m ON true
         ORDER BY wanted.ord`,
        [commodity.lab_methods, sampleId ?? null],
      );

      return { commodityId: commodity.id, commodityName: commodity.name, tests };
    });
  }

  // ---- Internals -------------------------------------------------------------------------

  private testIn(tx: Tx, id: string) {
    return tx.one<LabTest>(`SELECT ${TEST_COLUMNS} FROM lab_tests t WHERE t.id = $1`, [id]);
  }

  private methodIn(tx: Tx, id: string) {
    return tx.one<TestMethod>(
      `SELECT ${METHOD_COLUMNS} FROM test_methods m JOIN lab_tests t ON t.id = m.lab_test_id WHERE m.id = $1`,
      [id],
    );
  }

  private specificationIn(tx: Tx, id: string) {
    return tx.one<TestSpecification>(`SELECT ${SPEC_COLUMNS} FROM ${SPEC_FROM} WHERE s.id = $1`, [id]);
  }

  private instrumentIn(tx: Tx, id: string) {
    return tx.one<LabInstrument>(
      `SELECT ${INSTRUMENT_COLUMNS} FROM lab_instruments i JOIN laboratories l ON l.id = i.laboratory_id
       WHERE i.id = $1`,
      [id],
    );
  }
}

export interface TestInput {
  code: string;
  name: Record<string, string>;
  category?: string;
  description?: string | null;
  defaultUnit?: string | null;
  resultType?: LabResultType;
  sortOrder?: number;
}

export interface MethodInput {
  labTestId: string;
  code: string;
  name: string;
  standardReference?: string | null;
  description?: string | null;
  defaultUnit?: string | null;
  detectionLimit?: number | null;
  quantificationLimit?: number | null;
  accreditationScope?: string | null;
  effectiveFrom?: string | null;
}

export interface SpecificationInput {
  labTestId: string;
  testMethodId?: string | null;
  commodityId?: string | null;
  clientId?: string | null;
  contractId?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
  targetValue?: number | null;
  unit?: string | null;
  qualitativeRequirement?: string | null;
  notes?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface InstrumentInput {
  laboratoryId: string;
  code: string;
  name: string;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  calibrationDueAt?: string | null;
  notes?: string | null;
}



