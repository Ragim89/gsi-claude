import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Boots the real application — same modules, same global guard, same validation pipe — against
 * the test database. Nothing is mocked: a test that passes here exercises the SQL, the
 * Row-Level Security policies and the role checks the production API uses.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  return app;
}

export const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'ChangeMe123!';

/**
 * The refresh token is an httpOnly cookie (PHASE 12), invisible to a normal `request(app)` call
 * (each of those opens its own connection with no cookie jar). `login()` therefore uses a
 * `supertest` agent, which keeps cookies between calls the way a browser tab would — so a test
 * can call `session.agent.post('/api/auth/refresh')` and the right cookie goes along with it.
 */
export interface Session {
  accessToken: string;
  user: { id: string; branchId: string; role: string; email: string };
  agent: ReturnType<typeof request.agent>;
}

export async function login(app: INestApplication, email: string, password = SEED_PASSWORD): Promise<Session> {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post('/api/auth/login').send({ email, password }).expect(200);
  return { ...(res.body as Omit<Session, 'agent'>), agent };
}

/** Reads the raw refresh-token cookie value straight off the last response's Set-Cookie header —
 *  only tests may do this; a browser page has no way to read an httpOnly cookie. */
export function refreshCookieOf(res: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = list.find((c) => c.startsWith('gsi_rt='));
  if (!cookie) throw new Error('no gsi_rt cookie in response');
  return decodeURIComponent(cookie.split(';')[0].split('=')[1]);
}

/** Authenticated request helper: `as(app, session).get('/api/jobs')`. */
export function as(app: INestApplication, session: Session) {
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  return {
    get: (url: string) => session.agent.get(url).set(auth),
    post: (url: string) => session.agent.post(url).set(auth),
    put: (url: string) => session.agent.put(url).set(auth),
    patch: (url: string) => session.agent.patch(url).set(auth),
    delete: (url: string) => session.agent.delete(url).set(auth),
  };
}

export const ACCOUNTS = {
  admin: 'admin@gsi.local',
  cfo: 'cfo@gsi.local',
  financeTr: 'finance.tr@gsi.local',
  supervisorTr: 'supervisor.tr@gsi.local',
  inspectorTr: 'inspector.tr@gsi.local',
  inspector2Tr: 'inspector2.tr@gsi.local',
  samplerTr: 'sampler.tr@gsi.local',
  labTr: 'lab.tr@gsi.local',
  analystTr: 'analyst.tr@gsi.local',
  analyst2Tr: 'analyst2.tr@gsi.local',
  supervisorRo: 'supervisor.ro@gsi.local',
  inspectorRo: 'inspector.ro@gsi.local',
};
