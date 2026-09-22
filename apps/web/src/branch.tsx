import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Branch } from '@gsi/shared-types';
import { api } from './api';
import { useAuth } from './auth';

const STORAGE_KEY = 'gsi.branch';

interface BranchContextValue {
  /** Selected branch id, or null for "whole group". */
  branchId: string | null;
  setBranchId(id: string | null): void;
  branches: Branch[];
  current: Branch | null;
  /** True when the user may switch between branches at all (HQ roles). */
  canSwitch: boolean;
}

const BranchContext = createContext<BranchContextValue | null>(null);

/**
 * Group-wide branch filter. HQ users (admin / CFO) see every entity and can drill into one;
 * branch users are pinned to their own branch by Row-Level Security anyway, so for them the
 * selector is informational only. The choice is passed to every list endpoint as `branchId`
 * and kept in localStorage so it survives a reload.
 */
export function BranchProvider({ children }: { children: React.ReactNode }) {
  const { user, isHq } = useAuth();
  const [branchId, setBranchIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const branchesQuery = useQuery({
    queryKey: ['branches'],
    queryFn: () => api.get<Branch[]>('/branches'),
    enabled: Boolean(user),
    staleTime: 5 * 60_000,
  });
  const branches = useMemo(() => branchesQuery.data ?? [], [branchesQuery.data]);

  // Drop a stale selection (e.g. after switching to a user who cannot see that branch).
  useEffect(() => {
    if (branchId && branches.length && !branches.some((b) => b.id === branchId)) {
      setBranchIdState(null);
    }
  }, [branchId, branches]);

  const setBranchId = (id: string | null) => {
    setBranchIdState(id);
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const value: BranchContextValue = {
    branchId: isHq ? branchId : null,
    setBranchId,
    branches,
    current: branches.find((b) => b.id === (isHq ? branchId : user?.branchId)) ?? null,
    canSwitch: isHq && branches.length > 1,
  };
  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}

export function useBranch(): BranchContextValue {
  const ctx = useContext(BranchContext);
  if (!ctx) throw new Error('useBranch outside BranchProvider');
  return ctx;
}

/** `&branchId=…` for list endpoints, or '' for the whole group. */
export function useBranchParam(): string {
  const { branchId } = useBranch();
  return branchId ? `branchId=${branchId}` : '';
}

/** Regional-indicator flag for an ISO-3166 alpha-2 code — a visual cue, never the only one. */
export function flag(country: string): string {
  if (!/^[A-Za-z]{2}$/.test(country)) return '';
  return String.fromCodePoint(...[...country.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

export function BranchSwitcher() {
  const { t } = useTranslation();
  const { branchId, setBranchId, branches, canSwitch, current } = useBranch();

  if (!canSwitch) {
    return current ? (
      <div className="branch-pin" title={current.legalName}>
        <span aria-hidden>{flag(current.country)}</span> {current.code} · {current.city}
      </div>
    ) : null;
  }

  return (
    <label className="branch-switch">
      <span className="branch-switch__label">{t('branch.label')}</span>
      <select value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value || null)} aria-label={t('branch.label')}>
        <option value="">{t('branch.all')}</option>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {flag(b.country)} {b.code} — {b.city}
          </option>
        ))}
      </select>
    </label>
  );
}
