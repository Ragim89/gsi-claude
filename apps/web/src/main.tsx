import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeStyle } from '@gsi/ui-kit/react';
import { ApiError } from './api';
import { AuthProvider } from './auth';
import { BranchProvider } from './branch';
import { App } from './App';
import './i18n';
import './styles.css';

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
    <ThemeStyle />
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
            <BranchProvider>
              <App />
            </BranchProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
