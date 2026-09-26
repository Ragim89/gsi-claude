import React, { createContext, useContext, useEffect, useState } from 'react';
import type { AuthTokens, AuthUser, Permission, Role } from '@gsi/shared-types';
import { api, apiLogout, apiLogoutAll, getSession, onSessionChange, setSession } from './api';
import { applyUserLocale } from './i18n';

interface AuthContextValue {
  user: AuthUser | null;
  login(email: string, password: string): Promise<void>;
  logout(): void;
  /** Revokes every refresh token the user holds — signs out this device and every other one. */
  logoutAll(): Promise<void>;
  /**
   * What the signed-in person may do. The API enforces the same rules — this only decides
   * what is worth showing, so nobody is offered a button that will answer 403.
   */
  can(...permissions: Permission[]): boolean;
  hasRole(...roles: Role[]): boolean;
  /** Sees every office in the group. */
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

  // A session created before permissions existed carries none; those users see the
  // read-only parts of the app until their next sign-in.
  const permissions = user?.permissions ?? [];

  const value: AuthContextValue = {
    user,
    async login(email, password) {
      setSession(await api.post<AuthTokens>('/auth/login', { email, password }));
    },
    logout() {
      setSession(null);
      void apiLogout();
    },
    async logoutAll() {
      try {
        await apiLogoutAll();
      } finally {
        setSession(null);
      }
    },
    can: (...required) => required.some((p) => permissions.includes(p)),
    hasRole: (...roles) => !!user && roles.includes(user.role),
    isHq: user?.scope === 'global',
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
