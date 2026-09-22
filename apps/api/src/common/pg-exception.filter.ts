import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseError } from 'pg';

/** Maps PostgreSQL errors to meaningful HTTP responses instead of generic 500s. */
@Catch(DatabaseError)
export class PgExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Postgres');

  catch(err: DatabaseError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Database error';

    switch (err.code) {
      case '23505': // unique_violation
        status = HttpStatus.CONFLICT;
        message = 'Record already exists';
        break;
      case '23503': // foreign_key_violation
        status = HttpStatus.CONFLICT;
        message = 'Record is referenced by other data or refers to a missing record';
        break;
      case '23502': // not_null_violation (e.g. parent job not visible to caller)
      case '23514': // check_violation
      case '22P02': // invalid_text_representation (bad uuid / enum)
        status = HttpStatus.BAD_REQUEST;
        message = 'Invalid data';
        break;
      case '42501': // insufficient_privilege / RLS WITH CHECK failure
        status = HttpStatus.FORBIDDEN;
        message = 'Not allowed for your branch or role';
        break;
      default:
        this.logger.error(`${err.code} ${err.message}`, err.stack);
    }
    if (status !== HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.warn(`${err.code} ${err.message}`);
    }
    res.status(status).json({ statusCode: status, message });
  }
}

