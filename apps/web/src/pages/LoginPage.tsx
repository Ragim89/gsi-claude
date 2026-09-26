import { FormEvent, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, Field, Input, Logo } from '@gsi/ui-kit/react';
import { useAuth } from '../auth';
import { useBrand } from '../brand';
import { ErrorBox } from '../components/common';

export function LoginPage() {
  const { t } = useTranslation();
  const { user, login } = useAuth();
  const brand = useBrand();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/jobs';
    return <Navigate to={from} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login__panel">
        <div className="login__brand">
          <Logo variant="wordmark" height={54} src={brand?.logoUrl} alt={brand?.name ?? 'Company logo'} />
        </div>
        <Card title={t('login.title')}>
          <form className="stack" onSubmit={onSubmit}>
            <ErrorBox error={error} />
            <Field label={t('login.email')}>
              <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label={t('login.password')}>
              <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" loading={busy}>
              {t('login.submit')}
            </Button>
            {import.meta.env.DEV && <p className="muted" style={{ fontSize: 12, margin: 0 }}>{t('login.demoHint')}</p>}
          </form>
        </Card>
      </div>
    </div>
  );
}
