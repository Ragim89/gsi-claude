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

export interface TxOptions {
  /**
   * Lets this transaction see (and therefore write) rows that have been archived. Needed to
   * archive or restore a record, and by an administrator looking at the archive; every other
   * query keeps archived rows out of sight.
   */
  includeArchived?: boolean;
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
  async tx<T>(user: AuthUser | null, fn: (tx: Tx) => Promise<T>, options: TxOptions = {}): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (options.includeArchived) {
        // Archived rows are hidden by the policies themselves, which also means a row cannot
        // be archived — or restored — without this switch: the updated row has to stay
        // visible to the same policy that just allowed the change.
        await client.query(`SELECT set_config('app.include_archived', 'on', true)`);
      }
      if (user) {
        // Permissions travel as ",code,code," so a policy can match one exactly with a
        // substring test — cheaper than an array operator on every row.
        const permissions = user.permissions?.length ? `,${user.permissions.join(',')},` : '';
        await client.query(
          `SELECT set_config('app.user_id', $1, true),
                  set_config('app.branch_id', $2, true),
                  set_config('app.role', $3, true),
                  set_config('app.country_id', $4, true),
                  set_config('app.scope', $5, true),
                  set_config('app.permissions', $6, true)`,
          [user.id, user.branchId, user.role, user.countryId ?? '', user.scope ?? '', permissions],
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
