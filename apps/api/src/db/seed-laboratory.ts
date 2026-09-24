import type { Tx } from './db.service';

/**
 * Demo laboratory reference data: methods, a few specifications and the instruments behind
 * them.
 *
 * Migration 015 builds the test catalogue from `commodities.lab_methods`, which is real
 * reference data. Methods are a different matter — only a laboratory knows which standard it
 * works to and under whose accreditation — so the migration creates none and these exist for
 * the demo, the way the demo laboratories do. A real installation enters its own on the Methods
 * screen, and until it does, no analysis can be requested. That is the correct behaviour: a
 * laboratory that has not declared a method has not agreed to run it.
 */

const METHODS = [
  { test: 'moisture',       code: 'ISO-712',      name: 'Moisture content — oven drying',             standard: 'ISO 712:2009',    unit: '%',     dl: 0.05 },
  { test: 'protein',        code: 'ICC-105-2',    name: 'Crude protein — Kjeldahl',                   standard: 'ICC 105/2',       unit: '%',     dl: 0.1 },
  { test: 'gluten',         code: 'ICC-137',      name: 'Wet gluten — mechanical washing',            standard: 'ICC 137/1',       unit: '%',     dl: 0.5 },
  { test: 'test_weight',    code: 'ISO-7971',     name: 'Bulk density (test weight)',                 standard: 'ISO 7971-3:2019', unit: 'kg/hl', dl: 0.1 },
  { test: 'falling_number', code: 'ICC-107',      name: 'Falling number — Hagberg',                   standard: 'ICC 107/1',       unit: 's',     dl: 1 },
  { test: 'oil_content',    code: 'AOCS-AM2-93',  name: 'Oil content — NMR',                          standard: 'AOCS Am 2-93',    unit: '%',     dl: 0.1 },
  { test: 'free_fatty_acids', code: 'AOCS-CA5A',  name: 'Free fatty acids — titration',               standard: 'AOCS Ca 5a-40',   unit: '%',     dl: 0.01 },
  { test: 'foreign_matter', code: 'GAFTA-124-FM', name: 'Foreign matter — hand separation',           standard: 'GAFTA 124',       unit: '%',     dl: 0.01 },
  { test: 'impurities',     code: 'GAFTA-124-IM', name: 'Total impurities — hand separation',         standard: 'GAFTA 124',       unit: '%',     dl: 0.01 },
  { test: 'broken_grains',  code: 'GAFTA-124-BG', name: 'Broken grains — sieving and hand separation', standard: 'GAFTA 124',      unit: '%',     dl: 0.01 },
  { test: 'damaged_grains', code: 'GAFTA-124-DG', name: 'Damaged grains — visual assessment',         standard: 'GAFTA 124',       unit: '%',     dl: 0.01 },
  { test: 'screenings',     code: 'GAFTA-124-SC', name: 'Screenings — sieving',                       standard: 'GAFTA 124',       unit: '%',     dl: 0.01 },
  { test: 'aflatoxin',      code: 'AOAC-991-31',  name: 'Aflatoxin B1 — immunoaffinity HPLC',         standard: 'AOAC 991.31',     unit: 'ppm',   dl: 0.001 },
  { test: 'mycotoxins',     code: 'AOAC-994-01',  name: 'Mycotoxin screen — HPLC',                    standard: 'AOAC 994.01',     unit: 'ppm',   dl: 0.001 },
  { test: 'pesticides',     code: 'SOP-PEST-01',  name: 'Pesticide multi-residue screen',             standard: 'Internal SOP PEST-01', unit: null, dl: null },
  { test: 'gmo',           code: 'SOP-GMO-01',   name: 'GMO screening — real-time PCR',              standard: 'Internal SOP GMO-01',  unit: null, dl: null },
  { test: 'salmonella',     code: 'ISO-6579',     name: 'Salmonella detection',                       standard: 'ISO 6579-1:2017', unit: null,    dl: null },
  { test: 'germination',    code: 'ISTA-5-6',     name: 'Germination capacity',                       standard: 'ISTA 5.6',        unit: '%',     dl: 1 },
];

/** Commodity-level limits a grain laboratory would actually hold. */
const SPECIFICATIONS = [
  { commodity: 'wheat_milling', test: 'moisture',       max: 14.5, unit: '%' },
  { commodity: 'wheat_milling', test: 'protein',        min: 11.5, unit: '%' },
  { commodity: 'wheat_milling', test: 'gluten',         min: 23,   unit: '%' },
  { commodity: 'wheat_milling', test: 'test_weight',    min: 76,   unit: 'kg/hl' },
  { commodity: 'wheat_milling', test: 'foreign_matter', max: 2,    unit: '%' },
  { commodity: 'wheat_feed',    test: 'moisture',       max: 14.5, unit: '%' },
  { commodity: 'barley_feed',   test: 'moisture',       max: 14,   unit: '%' },
  { commodity: 'corn',          test: 'moisture',       max: 14.5, unit: '%' },
  { commodity: 'corn',          test: 'aflatoxin',      max: 0.02, unit: 'ppm' },
  { commodity: 'sunflower_seed', test: 'oil_content',   min: 42,   unit: '%' },
  { commodity: 'sunflower_seed', test: 'moisture',      max: 9,    unit: '%' },
];

const INSTRUMENTS = [
  { lab: 'TR-LAB', code: 'NIR-01', name: 'NIR grain analyser', manufacturer: 'Perten', model: 'IM 9500', monthsToCalibration: 7 },
  { lab: 'TR-LAB', code: 'OVEN-01', name: 'Drying oven', manufacturer: 'Memmert', model: 'UF55', monthsToCalibration: 4 },
  { lab: 'TR-LAB', code: 'KJEL-01', name: 'Kjeldahl distillation unit', manufacturer: 'Büchi', model: 'K-365', monthsToCalibration: 9 },
  // Deliberately already overdue: the warning on the result entry screen has to be visible in
  // the demo, and an overdue instrument is a fact of laboratory life rather than an error.
  { lab: 'TR-LAB', code: 'HPLC-01', name: 'HPLC system', manufacturer: 'Agilent', model: '1260 Infinity', monthsToCalibration: -2 },
  { lab: 'RO-LAB', code: 'NIR-02', name: 'NIR grain analyser', manufacturer: 'Foss', model: 'Infratec NOVA', monthsToCalibration: 5 },
];

export async function seedLaboratory(tx: Tx): Promise<void> {
  for (const m of METHODS) {
    await tx.exec(
      `INSERT INTO test_methods (lab_test_id, code, name, standard_reference, default_unit, detection_limit)
       SELECT t.id, $2, $3, $4, $5, $6::numeric FROM lab_tests t
       WHERE t.code = $1 AND NOT EXISTS (SELECT 1 FROM test_methods x WHERE x.code = $2)`,
      [m.test, m.code, m.name, m.standard, m.unit, m.dl],
    );
  }

  for (const s of SPECIFICATIONS) {
    await tx.exec(
      `INSERT INTO test_specifications (lab_test_id, commodity_id, min_value, max_value, unit)
       SELECT t.id, c.id, $3::numeric, $4::numeric, $5
       FROM lab_tests t, commodities c
       WHERE t.code = $1 AND c.code = $2
         AND NOT EXISTS (
           SELECT 1 FROM test_specifications x
           WHERE x.lab_test_id = t.id AND x.commodity_id = c.id AND x.contract_id IS NULL AND x.client_id IS NULL
         )`,
      [s.test, s.commodity, s.min ?? null, s.max ?? null, s.unit],
    );
  }

  for (const i of INSTRUMENTS) {
    await tx.exec(
      `INSERT INTO lab_instruments (laboratory_id, code, name, manufacturer, model, calibration_due_at)
       SELECT l.id, $2, $3, $4, $5, (current_date + make_interval(months => $6))::date
       FROM laboratories l
       WHERE l.code = $1 AND NOT EXISTS (SELECT 1 FROM lab_instruments x WHERE x.code = $2)`,
      [i.lab, i.code, i.name, i.manufacturer, i.model, i.monthsToCalibration],
    );
  }
}
