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
export function Logo({
  variant = 'wordmark',
  height = 40,
  className,
}: {
  variant?: 'globe' | 'wordmark' | 'stacked';
  height?: number;
  className?: string;
}) {
  const src = variant === 'globe' ? globe : variant === 'stacked' ? stacked : wordmark;
  return <img src={src} alt="General Survey Inspection Co." height={height} style={{ height }} className={className} />;
}

/** Globe + white lettering: for the navy/blue sidebar and other dark surfaces. */
export function LogoLockup({ size = 34 }: { size?: number }) {
  return (
    <div className="gsi-lockup">
      <img src={globe} alt="" width={size} height={size} className="gsi-lockup__globe" />
      <span className="gsi-lockup__text">
        <span className="gsi-lockup__name">General Survey</span>
        <span className="gsi-lockup__sub">Inspection Co.</span>
      </span>
    </div>
  );
}
