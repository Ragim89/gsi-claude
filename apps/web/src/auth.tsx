import React, { createContext, useContext, useEffect, useState } from 'react';
import type { AuthTokens, AuthUser, Role } from '@gsi/shared-types';
import { HQ_ROLES } from '@gsi/shared-types';
import { api, getSession, onSessionChange, setSession } from './api';
import { applyUserLocale } from './i18n';

interface AuthContextValue {
  user: AuthUser | null;
  login(email: string, password: string): Promise<void>;
  logout(): void;
  hasRole(...roles: Role[]): boolean;
  isHq: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(getSession()?.user ?? null);

  useEffect(() => {
    applyUserLocale(getSession()?.user?.locale);
    const off = onSessionChange((s) => {
      setUser(s?.user ?? null);
      applyUserLocale(s?.user?.locale);
    });
    return () => {
      off();
    };
  }, []);

  const value: AuthContextValue = {
    user,
    async login(email, password) {
      setSession(await api.post<AuthTokens>('/auth/login', { email, password }));
    },
    logout() {
      setSession(null);
    },
    hasRole: (...roles) => !!user && roles.includes(user.role),
    isHq: !!user && HQ_ROLES.includes(user.role),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** UI-level role gating. The API enforces the same rules (and RLS enforces branch isolation). */
export const canManage = (role: Role | undefined) => role === 'supervisor' || role === 'admin';
