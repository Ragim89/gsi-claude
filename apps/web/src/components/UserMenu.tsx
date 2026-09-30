import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@gsi/ui-kit/react';
import { useAuth } from '../auth';
import { LANGUAGES } from '../i18n';

function initials(name: string | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/**
 * The user's profile, moved from the sidebar footer into the header (requirement 6) — same
 * "button + panel" pattern as NotificationBell/GlobalSearchBox, not a new interaction shape.
 */
export function UserMenu() {
  const { t, i18n } = useTranslation();
  const { user, logout, logoutAll } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="user-menu__button" onClick={() => setOpen((o) => !o)} aria-label={t('nav.account')}>
        <span className="user-menu__avatar" aria-hidden="true">
          {initials(user?.fullName)}
        </span>
      </button>
      {open && (
        <div className="user-menu__panel">
          <div className="user-menu__head">
            <span className="user-menu__avatar user-menu__avatar--lg" aria-hidden="true">
              {initials(user?.fullName)}
            </span>
            <div>
              <div className="user-menu__name">{user?.fullName}</div>
              <div className="user-menu__role">{user ? t(`roleNames.${user.role}`) : ''}</div>
            </div>
          </div>
          <label className="user-menu__lang">
            {t('nav.language')}
            <select value={i18n.language} onChange={(e) => i18n.changeLanguage(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <div className="user-menu__actions">
            <Button variant="ghost" size="sm" onClick={logout}>
              {t('nav.logout')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void logoutAll()}>
              {t('nav.logoutAll')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
