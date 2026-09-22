import type { Branch, ChecklistInputKind, ChecklistResult, InspectionJob, LocalizedText } from '@gsi/shared-types';

export interface ReportPhoto {
  src: string; // data: URI
  takenAt: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
}

export interface ReportTemplateData {
  branch: Branch;
  client: {
    name: string;
    gaftaFosfaRef: string | null;
    address: string | null;
    country: string | null;
  };
  job: InspectionJob;
  items: Array<{
    itemKey: string;
    label: LocalizedText;
    inputKind: ChecklistInputKind;
    result: ChecklistResult | null;
    value: string | null;
    notes: string | null;
    photos: ReportPhoto[];
  }>;
  report: {
    number: string;
    version: number;
    issuedAt: Date;
    verifyUrl: string | null;
    qrDataUrl: string | null;
  };
  approvedByName: string | null;
  /** Unapproved preview: watermark, no QR. */
  draft: boolean;
}

export interface ReportTemplate {
  id: string;
  html(data: ReportTemplateData): string;
  footer(data: ReportTemplateData): string;
}
