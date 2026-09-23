import { HttpStatus } from '@nestjs/common';
import { DatabaseError } from 'pg';

/**
 * Maps PostgreSQL errors to meaningful HTTP responses instead of generic 500s.
 *
 * Several of these are not bugs but the schema doing its job: a Row-Level Security policy
 * refusing a write shows up as 42501, and a missing parent row as 23502, because the caller
 * cannot see the row it is trying to attach to.
 */
export function mapPgError(err: unknown): { status: number; message: string } | null {
  if (!(err instanceof DatabaseError)) return null;

  switch (err.code) {
    case '23505': // unique_violation
      return { status: HttpStatus.CONFLICT, message: 'Record already exists' };
    case '23503': // foreign_key_violation
      return {
        status: HttpStatus.CONFLICT,
        message: 'Record is referenced by other data or refers to a missing record',
      };
    case '23502': // not_null_violation (e.g. parent job not visible to caller)
    case '23514': // check_violation
    case '22P02': // invalid_text_representation (bad uuid / enum)
      return { status: HttpStatus.BAD_REQUEST, message: 'Invalid data' };
    case '42501': // insufficient_privilege / RLS WITH CHECK failure
      return { status: HttpStatus.FORBIDDEN, message: 'Not allowed for your branch or role' };
    default:
      return null; // Unexpected: treated as a server error and logged in full.
  }
}
