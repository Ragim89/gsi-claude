import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import puppeteer, { Browser } from 'puppeteer-core';
import { config } from '../config';

export interface PdfOptions {
  /** Raw HTML for Chromium's footer (isolated from page CSS: inline styles only). */
  footerHtml?: string;
}

/** HTML → PDF via headless Chromium (docs/04-media-reports.md). One shared browser, one page per render. */
@Injectable()
export class PdfService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfService.name);
  private browser: Promise<Browser> | null = null;

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = puppeteer
        .launch({
          executablePath: config.chromiumPath ?? '/usr/bin/chromium',
          headless: true,
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
        })
        .then((b) => {
          b.on('disconnected', () => {
            this.logger.warn('Chromium disconnected; will relaunch on next render');
            this.browser = null;
          });
          return b;
        })
        .catch((err) => {
          this.browser = null;
          throw err;
        });
    }
    return this.browser;
  }

  async render(html: string, opts: PdfOptions = {}): Promise<Buffer> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      // All images are inlined as data: URIs, so no network access is needed.
      await page.setJavaScriptEnabled(false);
      await page.setContent(html, { waitUntil: 'load', timeout: 60_000 });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: Boolean(opts.footerHtml),
        headerTemplate: '<span></span>',
        footerTemplate: opts.footerHtml ?? '<span></span>',
        margin: { top: '12mm', bottom: '18mm', left: '14mm', right: '14mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async onModuleDestroy() {
    if (this.browser) await (await this.browser).close().catch(() => undefined);
  }
}
