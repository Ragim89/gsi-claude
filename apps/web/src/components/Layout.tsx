import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, LogoLockup } from '@gsi/ui-kit/react';
import { useAuth } from '../auth';
import { BranchSwitcher } from '../branch';
import { LANGUAGES } from '../i18n';

export function Layout() {
  const { t, i18n } = useTranslation();
  const { user, logout, can } = useAuth();
  // The menu follows permissions, not roles: giving someone the right to read finance figures
  // is enough for the finance entries to appear, with no change here.
  const finance = can('finance.read');

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <LogoLockup />
        </div>
        <BranchSwitcher />
        <nav>
          {can('dashboard.read') && <NavLink to="/finance" end>{t('nav.dashboard')}</NavLink>}
          {can('branch.read') && <NavLink to="/branches">{t('nav.branches')}</NavLink>}
          {can('job.read') && (
            <NavLink to="/jobs">{user?.scope === 'own' ? t('nav.myJobs') : t('nav.jobs')}</NavLink>
          )}
          {can('client.read') && <NavLink to="/clients">{t('nav.clients')}</NavLink>}
          {finance && (
            <>
              <NavLink to="/finance/invoices">{t('nav.invoices')}</NavLink>
              <NavLink to="/finance/expenses">{t('nav.expenses')}</NavLink>
            </>
          )}
          {can('asset.read') && <NavLink to="/assets">{t('nav.assets')}</NavLink>}
          {can('import.run') && <NavLink to="/import">{t('nav.import')}</NavLink>}
          {can('user.read') && <NavLink to="/users">{t('nav.users')}</NavLink>}
          {can('role.manage') && <NavLink to="/admin/roles">{t('nav.roles')}</NavLink>}
          {can('audit.read') && <NavLink to="/admin/audit">{t('nav.audit')}</NavLink>}
        </nav>
        <div className="sidebar__footer">
          <div>
            <div className="sidebar__user">{user?.fullName}</div>
            <div className="sidebar__role">{user ? t(`roleNames.${user.role}`) : ''}</div>
          </div>
          <select aria-label={t('nav.language')} value={i18n.language} onChange={(e) => i18n.changeLanguage(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <Button variant="ghost" size="sm" onClick={logout}>
            {t('nav.logout')}
          </Button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
