import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeStyle } from '@gsi/ui-kit/react';
import { ApiError } from './api';
import { AuthProvider } from './auth';
import { BranchProvider } from './branch';
import { OfflineProvider } from './offline/OfflineProvider';
import { useBrand } from './brand';
import { App } from './App';
import './i18n';
import './styles.css';

/** Default tokens paint first frame; the organization's own colours (if any) apply once fetched. */
function BrandedTheme() {
  const brand = useBrand();
  return <ThemeStyle brand={brand ? { primaryColor: brand.primaryColor, secondaryColor: brand.secondaryColor } : undefined} />;
}

// The shell service worker only touches static assets — see public/sw.js for what it caches
// and, just as importantly, what it refuses to (anything under /api/).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline shell is a progressive enhancement, not a requirement to run the app */
    });
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrandedTheme />
      <BrowserRouter>
        <AuthProvider>
            <OfflineProvider>
              <BranchProvider>
                <App />
              </BranchProvider>
            </OfflineProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
