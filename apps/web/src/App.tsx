import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Permission } from '@gsi/shared-types';
import { useAuth } from './auth';
import { PageHead } from './components/common';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { JobsPage } from './pages/JobsPage';
import { JobFormPage } from './pages/JobFormPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { InspectionsPage } from './pages/InspectionsPage';
import { InspectionDetailPage } from './pages/InspectionDetailPage';
import { SamplesPage } from './pages/SamplesPage';
import { SampleDetailPage } from './pages/SampleDetailPage';
import { ClientsPage } from './pages/ClientsPage';
import { ClientDetailPage } from './pages/ClientDetailPage';
import { UsersPage } from './pages/UsersPage';
import { VerifyPage } from './pages/VerifyPage';
import { DashboardPage } from './pages/DashboardPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { ExpensesPage } from './pages/ExpensesPage';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage';
import { BranchesPage } from './pages/BranchesPage';
import { BranchDetailPage } from './pages/BranchDetailPage';
import { AssetsPage } from './pages/AssetsPage';
import { AssetDetailPage } from './pages/AssetDetailPage';
import { ImportPage } from './pages/ImportPage';
import { RolesPage } from './pages/RolesPage';
import { AuditPage } from './pages/AuditPage';
import { LaboratoriesPage } from './pages/LaboratoriesPage';
import { ContractsPage } from './pages/ContractsPage';
import { ReportsPage } from './pages/ReportsPage';
import { ReportDetailPage } from './pages/ReportDetailPage';
import { ReportNewPage } from './pages/ReportNewPage';
import { LabQueuePage } from './pages/LabQueuePage';
import { LabRequestDetailPage } from './pages/LabRequestDetailPage';
import { LabCataloguePage } from './pages/LabCataloguePage';
import { LabSpecificationsPage } from './pages/LabSpecificationsPage';
import { LabInstrumentsPage } from './pages/LabInstrumentsPage';

/**
 * Guards a route by permission. The API and Row-Level Security enforce the same rules, so
 * this exists to route people somewhere useful rather than to a wall of 403s.
 */
function RequireAuth({ need, children }: { need?: Permission[]; children: JSX.Element }) {
  const { user, can } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (need?.length && !can(...need)) return <Navigate to="/" replace />;
  return children;
}

/** Everyone lands on the most useful screen their permissions allow. */
function HomeRedirect() {
  const { user, can } = useAuth();
  // A field role opens their own inspections, not a dashboard they cannot act on.
  if (user?.scope === 'own' && can('inspection.read')) return <Navigate to="/inspections" replace />;
  // An analyst's home is the bench, not a dashboard of work that is not theirs.
  if (can('lab.result.enter') && !can('dashboard.read')) return <Navigate to="/lab" replace />;
  if (can('dashboard.read')) return <Navigate to="/finance" replace />;
  if (can('job.read')) return <Navigate to="/jobs" replace />;
  if (can('inspection.read')) return <Navigate to="/inspections" replace />;
  if (can('lab.test.read')) return <Navigate to="/lab" replace />;
  if (can('client.read')) return <Navigate to="/clients" replace />;
  // An account with no permissions at all: say so plainly rather than bounce between routes.
  return <NoAccess />;
}

function NoAccess() {
  const { t } = useTranslation();
  return (
    <div className="stack">
      <PageHead title={t('nav.noAccess')} sub={t('nav.noAccessHint')} />
    </div>
  );
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
        <Route path="/finance" element={<RequireAuth need={['dashboard.read']}><DashboardPage /></RequireAuth>} />
        <Route path="/finance/invoices" element={<RequireAuth need={['finance.read']}><InvoicesPage /></RequireAuth>} />
        <Route path="/finance/invoices/:id" element={<RequireAuth need={['finance.read']}><InvoiceDetailPage /></RequireAuth>} />
        <Route path="/finance/expenses" element={<RequireAuth need={['finance.read']}><ExpensesPage /></RequireAuth>} />
        <Route path="/assets" element={<RequireAuth need={['asset.read']}><AssetsPage /></RequireAuth>} />
        <Route path="/assets/:id" element={<RequireAuth need={['asset.read']}><AssetDetailPage /></RequireAuth>} />
        <Route path="/branches" element={<RequireAuth need={['dashboard.read']}><BranchesPage /></RequireAuth>} />
        <Route path="/branches/:id" element={<RequireAuth need={['branch.read']}><BranchDetailPage /></RequireAuth>} />
        <Route path="/jobs" element={<RequireAuth need={['job.read']}><JobsPage /></RequireAuth>} />
        <Route path="/jobs/new" element={<RequireAuth need={['job.create']}><JobFormPage /></RequireAuth>} />
        <Route path="/jobs/:id" element={<RequireAuth need={['job.read']}><JobDetailPage /></RequireAuth>} />
        <Route path="/jobs/:id/edit" element={<RequireAuth need={['job.update']}><JobFormPage /></RequireAuth>} />
        <Route path="/inspections" element={<RequireAuth need={['inspection.read']}><InspectionsPage /></RequireAuth>} />
        <Route path="/inspections/:id" element={<RequireAuth need={['inspection.read']}><InspectionDetailPage /></RequireAuth>} />
        <Route path="/samples" element={<RequireAuth need={['sample.read']}><SamplesPage /></RequireAuth>} />
        <Route path="/samples/:id" element={<RequireAuth need={['sample.read']}><SampleDetailPage /></RequireAuth>} />
        <Route path="/lab" element={<RequireAuth need={['lab.test.read']}><LabQueuePage /></RequireAuth>} />
        <Route path="/lab/requests/:id" element={<RequireAuth need={['lab.test.read']}><LabRequestDetailPage /></RequireAuth>} />
        <Route path="/lab/catalogue" element={<RequireAuth need={['lab.method.read']}><LabCataloguePage /></RequireAuth>} />
        <Route path="/lab/specifications" element={<RequireAuth need={['lab.specification.read']}><LabSpecificationsPage /></RequireAuth>} />
        <Route path="/lab/instruments" element={<RequireAuth need={['lab.instrument.read']}><LabInstrumentsPage /></RequireAuth>} />
        <Route path="/reports" element={<RequireAuth need={['report.read']}><ReportsPage /></RequireAuth>} />
        <Route path="/reports/new" element={<RequireAuth need={['report.create']}><ReportNewPage /></RequireAuth>} />
        <Route path="/reports/:id" element={<RequireAuth need={['report.read']}><ReportDetailPage /></RequireAuth>} />
        <Route path="/clients" element={<RequireAuth need={['client.read']}><ClientsPage /></RequireAuth>} />
        <Route path="/clients/:id" element={<RequireAuth need={['client.read']}><ClientDetailPage /></RequireAuth>} />
        <Route path="/contracts" element={<RequireAuth need={['contract.read']}><ContractsPage /></RequireAuth>} />
        <Route path="/import" element={<RequireAuth need={['import.run']}><ImportPage /></RequireAuth>} />
        <Route path="/users" element={<RequireAuth need={['user.read']}><UsersPage /></RequireAuth>} />
        <Route path="/admin/roles" element={<RequireAuth need={['role.manage']}><RolesPage /></RequireAuth>} />
        <Route path="/admin/audit" element={<RequireAuth need={['audit.read']}><AuditPage /></RequireAuth>} />
        <Route path="/admin/laboratories" element={<RequireAuth need={['org.manage']}><LaboratoriesPage /></RequireAuth>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
