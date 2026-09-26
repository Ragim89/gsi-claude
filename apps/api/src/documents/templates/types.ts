import type {
  Branch,
  ChecklistInputKind,
  ChecklistResult,
  FiscalSnapshot,
  InspectionJob,
  Invoice,
  InvoiceLine,
  LocalizedText,
} from '@gsi/shared-types';

export interface ReportPhoto {
  src: string; // data: URI
  takenAt: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
}

export interface TemplateOrganization {
  name: string;
  shortName: string | null;
  productName: string | null;
  logoUrl: string | null;
}

export interface ReportTemplateData {
  organization: TemplateOrganization;
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

export interface InvoiceTemplateData {
  organization: TemplateOrganization;
  branch: Branch;
  client: { name: string; address: string | null; taxId: string | null; gaftaFosfaRef: string | null };
  invoice: Invoice;
  lines: InvoiceLine[];
  /** Present only for a fiscal invoice (migration 028) — drives which template renders it,
   *  and is the KZ template's only source of seller/buyer fiscal data (see invoice-kz.ts). */
  fiscalSnapshot?: FiscalSnapshot | null;
}
