import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Input } from '@gsi/ui-kit/react';
import { SearchEntityType, SearchResult } from '@gsi/shared-types';
import { api } from '../api';

const ENTITY_ROUTE: Record<SearchEntityType, (id: string) => string> = {
  job: (id) => `/jobs/${id}`,
  client: (id) => `/clients/${id}`,
  sample: (id) => `/samples/${id}`,
  report: (id) => `/reports/${id}`,
  invoice: (id) => `/finance/invoices/${id}`,
};

/** PHASE 10 — global search across jobs, clients, samples, reports/certificates and invoices. */
export function GlobalSearchBox() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const results = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.get<SearchResult[]>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
  });

  const groups = (results.data ?? []).reduce<Record<string, SearchResult[]>>((acc, r) => {
    (acc[r.entityType] ??= []).push(r);
    return acc;
  }, {});

  function go(r: SearchResult) {
    setOpen(false);
    setQ('');
    navigate(ENTITY_ROUTE[r.entityType](r.id));
  }

  return (
    <div className="global-search" ref={ref}>
      <Input
        className="global-search__input"
        placeholder={t('search.placeholder')}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && debounced.length >= 2 && (
        <div className="global-search__panel">
          {results.isFetching && !results.data ? (
            <div style={{ padding: 'var(--gsi-space-3)' }} className="muted">
              {t('common.loading')}
            </div>
          ) : Object.keys(groups).length === 0 ? (
            <div style={{ padding: 'var(--gsi-space-3)' }} className="muted">
              {t('search.empty')}
            </div>
          ) : (
            Object.entries(groups).map(([type, rows]) => (
              <div key={type}>
                <div className="global-search__group">{t(`search.groups.${type}`)}</div>
                {rows.map((r) => (
                  <button key={`${r.entityType}-${r.id}`} type="button" className="global-search__item" onClick={() => go(r)}>
                    <span>
                      <strong>{r.number}</strong>{r.label && r.label !== r.number ? ` — ${r.label}` : ''}
                    </span>
                    <span className="muted">{r.branchCode}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
