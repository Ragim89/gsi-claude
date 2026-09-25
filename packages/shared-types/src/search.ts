/** PHASE 10 — Global search across the record types people look numbers up by. */

export const SEARCH_ENTITY_TYPES = ['job', 'client', 'sample', 'report', 'invoice'] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export interface SearchResult {
  entityType: SearchEntityType;
  id: string;
  number: string;
  label: string;
  branchCode: string;
  status: string | null;
}
