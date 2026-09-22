import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, LogoLockup } from '@gsi/ui-kit/react';
import { useAuth } from '../auth';
import { BranchSwitcher } from '../branch';
import { LANGUAGES } from '../i18n';

export function Layout() {
  const { t, i18n } = useTranslation();
  const { user, logout, hasRole } = useAuth();
  // Same role set as app_sees_finance() in the database; the API enforces it regardless.
  const finance = hasRole('finance_controller', 'supervisor', 'cfo', 'admin');

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <LogoLockup />
        </div>
        <BranchSwitcher />
        <nav>
          {finance && <NavLink to="/finance" end>{t('nav.dashboard')}</NavLink>}
          {finance && <NavLink to="/branches">{t('nav.branches')}</NavLink>}
          <NavLink to="/jobs">{hasRole('inspector') ? t('nav.myJobs') : t('nav.jobs')}</NavLink>
          <NavLink to="/clients">{t('nav.clients')}</NavLink>
          {finance && (
            <>
              <NavLink to="/finance/invoices">{t('nav.invoices')}</NavLink>
              <NavLink to="/finance/expenses">{t('nav.expenses')}</NavLink>
            </>
          )}
          {hasRole('admin') && <NavLink to="/users">{t('nav.users')}</NavLink>}
        </nav>
        <div className="sidebar__footer">
          <div>
            <div className="sidebar__user">{user?.fullName}</div>
            <div className="sidebar__role">{user ? t(`roles.${user.role}`) : ''}</div>
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
