import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, LogoLockup } from '@gsi/ui-kit/react';
import { useAuth } from '../auth';
import { BranchSwitcher } from '../branch';
import { LANGUAGES } from '../i18n';
import { GlobalSearchBox } from './GlobalSearchBox';
import { NotificationBell } from './NotificationBell';

interface NavItem {
  to: string;
  end?: boolean;
  label: string;
}

interface NavGroup {
  key: string;
  labelKey: string;
  items: NavItem[];
}

const OPEN_GROUPS_KEY = 'gsi.nav.openGroups';

function loadOpenGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(OPEN_GROUPS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function Layout() {
  const { t, i18n } = useTranslation();
  const { user, logout, can } = useAuth();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(loadOpenGroups);

  // The menu follows permissions, not roles: giving someone the right to read finance figures
  // is enough for the finance entries to appear, with no change here.
  const finance = can('finance.read');
  const own = user?.scope === 'own';

  const groups: NavGroup[] = [
    {
      key: 'crm',
      labelKey: 'nav.groups.crm',
      items: [
        ...(can('client.read') ? [{ to: '/clients', label: t('nav.clients') }] : []),
        ...(can('contract.read') ? [{ to: '/contracts', label: t('nav.contracts') }] : []),
      ],
    },
    {
      key: 'operations',
      labelKey: 'nav.groups.operations',
      items: [
        ...(can('job.read') ? [{ to: '/jobs', label: own ? t('nav.myJobs') : t('nav.jobs') }] : []),
        ...(can('inspection.read')
          ? [{ to: '/inspections', label: own ? t('nav.myInspections') : t('nav.inspections') }]
          : []),
        ...(can('sample.read') ? [{ to: '/samples', label: own ? t('nav.mySamples') : t('nav.samples') }] : []),
        ...(can('branch.read') ? [{ to: '/branches', label: t('nav.branches') }] : []),
        ...(can('asset.read') ? [{ to: '/assets', label: t('nav.assets') }] : []),
      ],
    },
    {
      key: 'laboratory',
      labelKey: 'nav.groups.laboratory',
      items: [
        ...(can('lab.test.read')
          ? [
              {
                to: '/lab',
                end: true,
                label: can('lab.result.enter') && !can('lab.test.assign') ? t('nav.myAnalyses') : t('nav.labQueue'),
              },
            ]
          : []),
        ...(can('lab.method.read') ? [{ to: '/lab/catalogue', label: t('nav.labCatalogue') }] : []),
        ...(can('lab.specification.read')
          ? [{ to: '/lab/specifications', label: t('nav.labSpecifications') }]
          : []),
        ...(can('lab.instrument.read') ? [{ to: '/lab/instruments', label: t('nav.labInstruments') }] : []),
      ],
    },
    {
      key: 'documents',
      labelKey: 'nav.groups.documents',
      items: [...(can('report.read') ? [{ to: '/reports', label: t('nav.reports') }] : [])],
    },
    {
      key: 'finance',
      labelKey: 'nav.groups.finance',
      items: [
        ...(can('dashboard.read') ? [{ to: '/finance', end: true, label: t('nav.dashboard') }] : []),
        ...(can('quote.read') ? [{ to: '/finance/quotes', label: t('nav.quotes') }] : []),
        ...(finance
          ? [
              { to: '/finance/invoices', label: t('nav.invoices') },
              { to: '/finance/expenses', label: t('nav.expenses') },
            ]
          : []),
        ...(can('payment.read') ? [{ to: '/finance/payments', label: t('nav.payments') }] : []),
        ...(can('service.read') ? [{ to: '/finance/pricing', label: t('nav.pricing') }] : []),
      ],
    },
    {
      key: 'analytics',
      labelKey: 'nav.groups.analytics',
      items: [
        ...(can('analytics.read')
          ? [{ to: '/analytics', label: own ? t('nav.myAnalytics') : t('nav.analytics') }]
          : []),
      ],
    },
    {
      key: 'administration',
      labelKey: 'nav.groups.administration',
      items: [
        ...(can('import.run') ? [{ to: '/import', label: t('nav.import') }] : []),
        ...(can('user.read') ? [{ to: '/users', label: t('nav.users') }] : []),
        ...(can('role.manage') ? [{ to: '/admin/roles', label: t('nav.roles') }] : []),
        ...(can('org.manage') ? [{ to: '/admin/laboratories', label: t('nav.laboratories') }] : []),
        ...(can('audit.read') ? [{ to: '/admin/audit', label: t('nav.audit') }] : []),
      ],
    },
  ];

  const visibleGroups = groups.filter((g) => g.items.length > 0);
  const totalItems = visibleGroups.reduce((n, g) => n + g.items.length, 0);
  // A handful of links reads better flat: grouping four items under one header adds a click
  // with nothing left to organise. This is the common shape for an own-scope field role.
  const flat = totalItems <= 4;

  function groupHasActiveRoute(group: NavGroup): boolean {
    return group.items.some((item) =>
      item.end ? location.pathname === item.to : location.pathname.startsWith(item.to),
    );
  }

  function isGroupOpen(group: NavGroup): boolean {
    if (groupHasActiveRoute(group)) return true;
    if (group.key in openGroups) return openGroups[group.key];
    // HQ and admin menus default to compact so the full list fits without scrolling past it;
    // a scoped role rarely reaches enough groups for this to matter.
    return user?.scope !== 'global';
  }

  function toggleGroup(key: string, group: NavGroup) {
    setOpenGroups((prev) => {
      const next = { ...prev, [key]: !isGroupOpen(group) };
      try {
        localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }

  const closeMobile = () => setMobileOpen(false);

  return (
    <div className="shell">
      <div className="topbar-mobile">
        <button
          type="button"
          className="topbar-mobile__menu-btn"
          aria-label={t('nav.openMenu')}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(true)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <LogoLockup />
      </div>

      {mobileOpen && <div className="sidebar-backdrop" onClick={closeMobile} />}

      <aside className={`sidebar${mobileOpen ? ' sidebar--open' : ''}`}>
        <div className="sidebar__brand sidebar__brand--row">
          <LogoLockup />
          <button
            type="button"
            className="sidebar__close"
            aria-label={t('nav.closeMenu')}
            onClick={closeMobile}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <BranchSwitcher />
        <nav onClick={closeMobile}>
          {flat
            ? visibleGroups.flatMap((g) =>
                g.items.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end}>
                    {item.label}
                  </NavLink>
                )),
              )
            : visibleGroups.map((g) => {
                const open = isGroupOpen(g);
                return (
                  <div key={g.key} className={`nav-group${open ? ' is-open' : ''}`}>
                    <button
                      type="button"
                      className="nav-group__head"
                      aria-expanded={open}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleGroup(g.key, g);
                      }}
                    >
                      <span>{t(g.labelKey)}</span>
                      <span className="nav-group__chevron" aria-hidden="true">
                        ›
                      </span>
                    </button>
                    {open && (
                      <div className="nav-group__items">
                        {g.items.map((item) => (
                          <NavLink key={item.to} to={item.to} end={item.end}>
                            {item.label}
                          </NavLink>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
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
        <div className="topbar">
          {can('search.read') && <GlobalSearchBox />}
          {can('notification.read') && <NotificationBell />}
        </div>
        <Outlet />
      </main>
    </div>
  );
}
