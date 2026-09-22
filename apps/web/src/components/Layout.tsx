import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@gsi/ui-kit/react';
import { useAuth } from '../auth';
import { LANGUAGES } from '../i18n';

export function Layout() {
  const { t, i18n } = useTranslation();
  const { user, logout, hasRole } = useAuth();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <div className="sidebar__mark">GSI</div>
          <div className="sidebar__tag">{t('app.tagline')}</div>
        </div>
        <nav>
          <NavLink to="/jobs">{hasRole('inspector') ? t('nav.myJobs') : t('nav.jobs')}</NavLink>
          <NavLink to="/clients">{t('nav.clients')}</NavLink>
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
