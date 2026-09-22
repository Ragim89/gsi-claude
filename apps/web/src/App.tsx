import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Role } from '@gsi/shared-types';
import { useAuth } from './auth';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { JobsPage } from './pages/JobsPage';
import { JobFormPage } from './pages/JobFormPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { ClientsPage } from './pages/ClientsPage';
import { ClientDetailPage } from './pages/ClientDetailPage';
import { UsersPage } from './pages/UsersPage';
import { VerifyPage } from './pages/VerifyPage';
import { DashboardPage } from './pages/DashboardPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { ExpensesPage } from './pages/ExpensesPage';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage';

/** Roles allowed into the finance area (mirrors app_sees_finance() in the database). */
const FINANCE: Role[] = ['finance_controller', 'supervisor', 'cfo', 'admin'];

function RequireAuth({ roles, children }: { roles?: Role[]; children: JSX.Element }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/jobs" replace />;
  return children;
}

/** Finance roles land on the dashboard; operations roles on their job list. */
function HomeRedirect() {
  const { user } = useAuth();
  const finance = user && ['cfo', 'finance_controller'].includes(user.role);
  return <Navigate to={finance ? '/finance' : '/jobs'} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/verify/:token" element={<VerifyPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/finance" element={<RequireAuth roles={FINANCE}><DashboardPage /></RequireAuth>} />
        <Route path="/finance/invoices" element={<RequireAuth roles={FINANCE}><InvoicesPage /></RequireAuth>} />
        <Route path="/finance/invoices/:id" element={<RequireAuth roles={FINANCE}><InvoiceDetailPage /></RequireAuth>} />
        <Route path="/finance/expenses" element={<RequireAuth roles={FINANCE}><ExpensesPage /></RequireAuth>} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/jobs/new" element={<RequireAuth roles={['supervisor', 'admin']}><JobFormPage /></RequireAuth>} />
        <Route path="/jobs/:id" element={<JobDetailPage />} />
        <Route path="/jobs/:id/edit" element={<RequireAuth roles={['supervisor', 'admin']}><JobFormPage /></RequireAuth>} />
        <Route path="/clients" element={<ClientsPage />} />
        <Route path="/clients/:id" element={<ClientDetailPage />} />
        <Route path="/users" element={<RequireAuth roles={['admin']}><UsersPage /></RequireAuth>} />
      </Route>
      <Route path="*" element={<Navigate to="/jobs" replace />} />
    </Routes>
  );
}
