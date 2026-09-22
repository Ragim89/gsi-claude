import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ClientBase, Pool } from 'pg';
import type { AuthUser } from '@gsi/shared-types';
import { config } from '../config';

/** Minimal query surface handed to services; always bound to one transaction. */
export interface Tx {
  many<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
  one<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R | null>;
  exec(sql: string, params?: unknown[]): Promise<number>;
}

export function wrapClient(client: ClientBase): Tx {
  return {
    async many<R>(sql: string, params: unknown[] = []) {
      return (await client.query(sql, params)).rows as R[];
    },
    async one<R>(sql: string, params: unknown[] = []) {
      return ((await client.query(sql, params)).rows[0] as R | undefined) ?? null;
    },
    async exec(sql: string, params: unknown[] = []) {
      return (await client.query(sql, params)).rowCount ?? 0;
    },
  };
}

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly pool = new Pool({ connectionString: config.databaseUrl, max: 20 });

  /**
   * Runs `fn` in a transaction with the caller's security context applied.
   * set_config(..., true) scopes the values to this transaction only, so a pooled
   * connection never leaks one user's branch into another request.
   * Every Row-Level Security policy in the schema reads these values.
   */
  async tx<T>(user: AuthUser | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (user) {
        await client.query(
          `SELECT set_config('app.user_id', $1, true),
                  set_config('app.branch_id', $2, true),
                  set_config('app.role', $3, true)`,
          [user.id, user.branchId, user.role],
        );
      }
      const result = await fn(wrapClient(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
