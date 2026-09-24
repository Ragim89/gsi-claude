import React from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, BadgeTone, Spinner } from '@gsi/ui-kit/react';
import { JobStatus, localize, SERVICE_TYPE_LABELS, ServiceType } from '@gsi/shared-types';
import { ApiError } from '../api';

const STATUS_TONE: Record<JobStatus, BadgeTone> = {
  draft: 'neutral',
  confirmed: 'info',
  assigned: 'info',
  in_progress: 'accent',
  sampling: 'accent',
  lab: 'accent',
  report_preparation: 'accent',
  under_review: 'warning',
  approved: 'success',
  completed: 'success',
  invoiced: 'success',
  closed: 'neutral',
  on_hold: 'warning',
  cancelled: 'danger',
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Badge>;
}

export function useServiceLabel() {
  const { i18n } = useTranslation();
  return (type: ServiceType) => localize(SERVICE_TYPE_LABELS[type], i18n.language);
}

export function useFormatDate() {
  const { i18n } = useTranslation();
  return (value: string | null | undefined, withTime = true) => {
    if (!value) return '—';
    // A plain YYYY-MM-DD is a calendar day, not an instant: parsing it as UTC and then
    // printing it locally would shift contract dates by a day in half the group's offices.
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const date = dateOnly ? new Date(`${value}T12:00:00`) : new Date(value);
    return new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      ...(withTime && !dateOnly ? { timeStyle: 'short' } : {}),
    }).format(date);
  };
}

export function Loading() {
  const { t } = useTranslation();
  return (
    <div className="row-actions muted" style={{ padding: 24 }}>
      <Spinner /> {t('common.loading')}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const msg = error instanceof ApiError || error instanceof Error ? error.message : t('common.error');
  return <Alert>{msg}</Alert>;
}

export function PageHead({ title, sub, actions }: { title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub ? <div className="page-head__sub">{sub}</div> : null}
      </div>
      {actions ? <div className="row-actions">{actions}</div> : null}
    </div>
  );
}

/** datetime-local input value <-> ISO string helpers. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}
