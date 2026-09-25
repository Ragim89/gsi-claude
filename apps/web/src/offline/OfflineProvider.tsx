import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from '../auth';
import { initOfflineSync, OfflineOp, setActiveUser, subscribe, syncNow } from './queue';

export type OfflineStatus = 'offline' | 'queued' | 'syncing' | 'conflict' | 'failed' | 'synced';

interface OfflineContextValue {
  isOnline: boolean;
  ops: OfflineOp[];
  status: OfflineStatus;
  pendingCount: number;
  conflictCount: number;
  syncNow(): void;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

/**
 * Owns the offline queue's active user and exposes its state to the app. Switching users
 * (login/logout) re-points the queue at the new `userId` so one person's queued field work
 * never surfaces — or syncs — under someone else's session.
 */
export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [isOnline, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [ops, setOps] = useState<OfflineOp[]>([]);

  useEffect(() => {
    initOfflineSync();
  }, []);

  useEffect(() => {
    setActiveUser(user?.id ?? null);
  }, [user?.id]);

  useEffect(() => {
    return subscribe(setOps);
  }, []);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const conflictCount = ops.filter((o) => o.status === 'conflict').length;
  const syncingCount = ops.filter((o) => o.status === 'syncing').length;
  const pending = ops.length - conflictCount;

  let status: OfflineStatus = 'synced';
  if (!isOnline) status = 'offline';
  else if (conflictCount > 0) status = 'conflict';
  else if (syncingCount > 0) status = 'syncing';
  else if (ops.some((o) => o.status === 'failed')) status = 'failed';
  else if (pending > 0) status = 'queued';

  const value: OfflineContextValue = {
    isOnline,
    ops,
    status,
    pendingCount: pending,
    conflictCount,
    syncNow: () => void syncNow(),
  };

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineContextValue {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error('useOffline outside OfflineProvider');
  return ctx;
}
