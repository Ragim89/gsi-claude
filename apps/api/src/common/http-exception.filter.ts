import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { config } from '../config';
import { mapPgError } from './pg-error';
import type { RequestWithContext } from './request-context';

/**
 * The one place an error becomes a response.
 *
 * Users never see a stack trace, a SQL fragment or the word "500": they get a short
 * explanation and a reference id that matches the server log. Known errors (validation,
 * permissions, conflicts) keep their message, because those messages are written for people.
 *
 * `message` stays at the top level for backward compatibility with the web client, next to
 * the newer structured fields.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<RequestWithContext>();

    // The SSE stream and file downloads may already have started writing.
    if (res.headersSent) return;

    const isHttp = exception instanceof HttpException;
    const pg = isHttp ? null : mapPgError(exception);
    const status = isHttp ? exception.getStatus() : pg?.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = isHttp ? exception.getResponse() : null;

    let message: string;
    let details: unknown;
    if (pg) {
      message = pg.message;
      this.logger.warn(`${req?.requestId ?? '-'} ${(exception as { code?: string }).code} ${pg.message}`);
    } else if (typeof payload === 'string') {
      message = payload;
    } else if (payload && typeof payload === 'object') {
      const body = payload as { message?: string | string[]; error?: string };
      if (Array.isArray(body.message)) {
        // class-validator returns one string per broken rule.
        message = body.message.join('; ');
        details = body.message;
      } else {
        message = body.message ?? body.error ?? 'Request failed';
      }
    } else {
      message = 'Something went wrong on our side. Please try again.';
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const err = exception as Error;
      this.logger.error(
        `${req?.requestId ?? '-'} ${req?.method} ${req?.originalUrl} → ${err?.message}`,
        err?.stack,
      );
      // Never leak internals, not even in development: the log has the full story.
      message = 'Something went wrong on our side. Please try again.';
      details = undefined;
    }

    res.status(status).json({
      statusCode: status,
      message,
      ...(details ? { details } : {}),
      requestId: req?.requestId,
      path: req?.originalUrl?.split('?')[0],
      timestamp: new Date().toISOString(),
      ...(config.isProduction ? {} : { env: config.env }),
    });
  }
}
