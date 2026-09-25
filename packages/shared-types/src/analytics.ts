import type { JobStatus, ServiceType } from './enums';

// ---------------------------------------------------------------------------
// PHASE 9 — Analytics. Read-only aggregates over jobs, inspections, samples, the laboratory
// and reports; no new tables. Row-Level Security does the scoping exactly as it does for the
// finance dashboard, so the same endpoint answers "the group" for HQ and "my own work" for a
// field role — the numbers are simply whatever that caller's rows resolve to.
// ---------------------------------------------------------------------------

/** Like finance's BreakdownSlice, but counting jobs rather than money. */
export interface BreakdownCountSlice {
  key: string;
  label?: string;
  count: number;
  share: number;
}

export interface JobsByStatusSlice {
  status: JobStatus;
  count: number;
}

export interface JobsAnalytics {
  period: { from: string; to: string };
  totals: { jobCount: number };
  monthly: { month: string; count: number }[];
  byBranch: (BreakdownCountSlice & { branchId: string; branchCode: string; country: string; city: string })[];
  byCountry: (BreakdownCountSlice & { country: string })[];
  byClient: (BreakdownCountSlice & { clientId: string })[];
  byService: (BreakdownCountSlice & { key: ServiceType })[];
  byStatus: JobsByStatusSlice[];
  generatedAt: string;
}

/**
 * One turnaround stage: calendar days between two real, already-recorded events. `sampleSize`
 * is how many jobs actually have both timestamps — the only honest denominator. A stage with
 * no qualifying jobs reports null averages rather than a fabricated zero.
 */
export interface TurnaroundStage {
  key: 'jobToInspection' | 'inspectionToLab' | 'labToReleased' | 'releasedToReport' | 'jobToReport';
  sampleSize: number;
  avgDays: number | null;
  medianDays: number | null;
  p90Days: number | null;
}

export interface TurnaroundAnalytics {
  period: { from: string; to: string };
  stages: TurnaroundStage[];
  /** Job → Report overall, trended by the month the report was issued. */
  monthly: { month: string; avgDays: number | null; sampleSize: number }[];
  generatedAt: string;
}

export interface WorkloadRow {
  userId: string;
  name: string;
  branchCode?: string;
  active: number;
  completed: number;
}

export interface LaboratoryWorkloadRow {
  laboratoryId: string;
  name: string;
  active: number;
  completed: number;
}

export interface WorkloadAnalytics {
  period: { from: string; to: string };
  inspectors: WorkloadRow[];
  samplers: WorkloadRow[];
  labAnalysts: WorkloadRow[];
  laboratories: LaboratoryWorkloadRow[];
  reviewers: WorkloadRow[];
  generatedAt: string;
}
