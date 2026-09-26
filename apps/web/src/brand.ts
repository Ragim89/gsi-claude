import { useQuery } from '@tanstack/react-query';
import type { OrganizationBrand } from '@gsi/shared-types';
import { api } from './api';

/**
 * Organization branding (PHASE 13.5, docs/WHITE_LABEL.md): name, colours and logo, read from
 * `GET /org/brand` — unauthenticated, so the login screen and the PWA shell can use it before
 * anyone has signed in. `undefined` while loading; every consumer already falls back to a
 * generic default (see Layout.tsx, LoginPage.tsx), so a slow or failed fetch never blocks the
 * screen it brands.
 */
export function useBrand() {
  return useQuery({
    queryKey: ['org', 'brand'],
    queryFn: () => api.get<OrganizationBrand>('/org/brand'),
    staleTime: Infinity,
    retry: 1,
  }).data;
}
