import { Logger } from '@nestjs/common';
import type { ReportTemplate } from './types';
import { trDefaultTemplate } from './tr-default';

const TEMPLATES: Record<string, ReportTemplate> = {
  [trDefaultTemplate.id]: trDefaultTemplate,
};

const logger = new Logger('ReportTemplates');

/**
 * Resolves the letterhead template for a branch (branches.letterhead_template_id).
 * ASSUMPTION: MVP-1 ships only the Turkish template; other branches fall back to it
 * (with their own legal name / address) until their forms are received (open question #4).
 */
export function resolveTemplate(id: string): ReportTemplate {
  const t = TEMPLATES[id];
  if (!t) {
    logger.warn(`template "${id}" not found, falling back to tr-default`);
    return trDefaultTemplate;
  }
  return t;
}

export type { ReportTemplate, ReportTemplateData } from './types';
