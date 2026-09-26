import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@gsi/ui-kit/react';
import { useBrand } from '../brand';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'gsi.pwa.installDismissed';

/**
 * Chrome/Edge/Android fire `beforeinstallprompt` and let a site trigger it later, on its own
 * banner, instead of the browser's address-bar icon — the only way to surface installability
 * to someone who would not otherwise notice it. iOS Safari never fires this event; there is no
 * equivalent prompt to show there, so the banner simply never appears.
 */
export function InstallPrompt() {
  const { t } = useTranslation();
  const brand = useBrand();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  if (!deferred || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <div className="install-banner" role="complementary">
      <div>
        <strong>{t('pwa.installTitle', { name: brand?.productName ?? brand?.name ?? t('pwa.installTitleFallback') })}</strong>
        <div className="muted">{t('pwa.installBody')}</div>
      </div>
      <div className="row-actions">
        <Button
          size="sm"
          onClick={async () => {
            await deferred.prompt();
            await deferred.userChoice;
            setDeferred(null);
          }}
        >
          {t('pwa.install')}
        </Button>
        <Button variant="ghost" size="sm" onClick={dismiss}>
          {t('pwa.dismiss')}
        </Button>
      </div>
    </div>
  );
}
