import { Controller, Get, HttpCode, HttpStatus, Module, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Public } from '../common/decorators';
import { DbService } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { config } from '../config';

interface Check {
  status: 'ok' | 'down';
  latencyMs?: number;
  error?: string;
}

async function timed(fn: () => Promise<unknown>): Promise<Check> {
  const started = Date.now();
  try {
    await fn();
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - started, error: (err as Error).message };
  }
}

/**
 * Three endpoints, because an orchestrator asks three different questions:
 *
 * - `/api/health/live` — is the process alive? (never touches dependencies, so a database
 *   outage does not get the container killed and restarted in a loop)
 * - `/api/health/ready` — can it serve traffic? (checks the database and object storage)
 * - `/api/health` — the human-readable summary, also used by docker-compose
 */
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(private readonly db: DbService, private readonly storage: StorageService) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000) };
  }

  @Public()
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks = await this.collect();
    const ok = Object.values(checks).every((c) => c.status === 'ok');
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'degraded', checks };
  }

  @Public()
  @Get()
  async health(@Res({ passthrough: true }) res: Response) {
    const checks = await this.collect();
    const ok = Object.values(checks).every((c) => c.status === 'ok');
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ok ? 'ok' : 'degraded',
      env: config.env,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }

  private async collect(): Promise<Record<string, Check>> {
    const [database, storage] = await Promise.all([
      timed(() => this.db.tx(null, (tx) => tx.one('SELECT 1'))),
      timed(() => this.storage.ping()),
    ]);
    return { database, storage };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
