import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth';
import { useBrand } from '../brand';
import { HeroPortArt } from '../assets/heroArt';

/**
 * Dashboard Visual Upgrade 2.0 — hero banner.
 *
 * The background photo is never hardcoded here: it comes from the active client profile
 * (`VITE_DASHBOARD_HERO_IMAGE`, set per deployment in config/clients/<profile>/web.env and
 * applied by scripts/apply-client-profile.mjs — see docs/WHITE_LABEL.md) so a white-label
 * deployment can swap in its own inspection/port photography without touching this component.
 * When no profile image is configured, an original abstract port/vessel illustration is used
 * instead of a stock photo, over the organization's own brand gradient.
 */
export function DashboardHero({ summary, period }: { summary: ReactNode; period?: ReactNode }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const brand = useBrand();
  const heroImage = (import.meta.env.VITE_DASHBOARD_HERO_IMAGE as string | undefined)?.trim();

  const hour = new Date().getHours();
  const greetingKey = hour < 12 ? 'dashboardHome.greetingMorning' : hour < 18 ? 'dashboardHome.greetingAfternoon' : 'dashboardHome.greetingEvening';
  const firstName = user?.fullName?.split(' ')[0] ?? '';
  const productName = brand?.productName ?? brand?.shortName ?? t('nav.dashboard');

  return (
    <section className="dash-hero">
      <div className="dash-hero__art" aria-hidden="true">
        {heroImage ? <img src={heroImage} alt="" /> : <HeroPortArt />}
      </div>
      <div className="dash-hero__scrim" aria-hidden="true" />
      <div className="dash-hero__content">
        <div className="dash-hero__eyebrow">{productName}</div>
        <h1 className="dash-hero__title">{t(greetingKey, { name: firstName })}</h1>
        <p className="dash-hero__summary">{summary}</p>
        {period ? <div className="dash-hero__period">{period}</div> : null}
      </div>
    </section>
  );
}
