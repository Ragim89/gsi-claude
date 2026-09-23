import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from '@nestjs/common';
import { config } from '../config';

export interface RequestWithContext extends Request {
  requestId: string;
  user?: { id: string; role: string; branchId: string };
}

const logger = new Logger('HTTP');

/**
 * Gives every request an id, returns it in `X-Request-Id`, and logs one line per request.
 *
 * The id is what ties a user-visible error message ("reference: 8f3a…") to the server log,
 * so support can find the failure without asking the user to reproduce it. Bodies are never
 * logged — they contain client data, passwords and financial figures.
 */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const r = req as RequestWithContext;
  const incoming = req.headers['x-request-id'];
  r.requestId = typeof incoming === 'string' && incoming.length <= 64 ? incoming : randomUUID();
  res.setHeader('X-Request-Id', r.requestId);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // Health checks are polled every few seconds by the orchestrator; logging them is noise.
    if (req.originalUrl.startsWith('/api/health') && res.statusCode < 400) return;

    const entry = {
      requestId: r.requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(ms),
      userId: r.user?.id,
      role: r.user?.role,
      ip: req.ip,
    };
    const line = config.logJson
      ? JSON.stringify(entry)
      : `${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms${entry.role ? ` ${entry.role}` : ''}`;
    if (res.statusCode >= 500) logger.error(line);
    else if (res.statusCode >= 400) logger.warn(line);
    else logger.log(line);
  });

  next();
}
