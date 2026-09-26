import React from 'react';
import globe from '../assets/logo-globe.webp';
import wordmark from '../assets/logo-wordmark.png';
import stacked from '../assets/logo-stacked.png';

/**
 * Official GSI logo. The source files live in packages/ui-kit/src/assets and are the same
 * ones handed over by the company; never redraw the mark in CSS or type it as text.
 *
 * ASSUMPTION: only raster files were provided. A vector (SVG) version would render sharper
 * on high-DPI screens and in PDFs — still worth requesting (docs/07-open-questions.md #1).
 * The wordmark is black, so on a blue surface use variant="globe" plus separate white text
 * (`<LogoLockup />`), which is what the sidebar does.
 */
/**
 * `src`/`alt` let a deployment override the printed mark from its own organization branding
 * (PHASE 13.5, docs/WHITE_LABEL.md) without this component knowing where that config comes
 * from — the caller (Layout, LoginPage, …) reads it and passes it down. Omitted, both fall back
 * to the bundled asset, exactly as before this override existed.
 */
export function Logo({
  variant = 'wordmark',
  height = 40,
  className,
  src,
  alt = 'Company logo',
}: {
  variant?: 'globe' | 'wordmark' | 'stacked';
  height?: number;
  className?: string;
  src?: string | null;
  alt?: string;
}) {
  const fallback = variant === 'globe' ? globe : variant === 'stacked' ? stacked : wordmark;
  return <img src={src || fallback} alt={alt} height={height} style={{ height }} className={className} />;
}

/** Globe + lettering: for the navy/blue sidebar and other dark surfaces. */
export function LogoLockup({
  size = 34,
  src,
  name = 'Company',
  sub,
}: {
  size?: number;
  src?: string | null;
  name?: string;
  sub?: string;
}) {
  return (
    <div className="gsi-lockup">
      <img src={src || globe} alt="" width={size} height={size} className="gsi-lockup__globe" />
      <span className="gsi-lockup__text">
        <span className="gsi-lockup__name">{name}</span>
        {sub ? <span className="gsi-lockup__sub">{sub}</span> : null}
      </span>
    </div>
  );
}
