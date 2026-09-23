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

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; branchId: string; role: string; email: string };
}

export async function login(app: INestApplication, email: string, password = SEED_PASSWORD): Promise<Session> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ email, password })
    .expect(200);
  return res.body as Session;
}

/** Authenticated request helper: `as(app, session).get('/api/jobs')`. */
export function as(app: INestApplication, session: Session) {
  const agent = request(app.getHttpServer());
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  return {
    get: (url: string) => agent.get(url).set(auth),
    post: (url: string) => agent.post(url).set(auth),
    patch: (url: string) => agent.patch(url).set(auth),
    delete: (url: string) => agent.delete(url).set(auth),
  };
}

export const ACCOUNTS = {
  admin: 'admin@gsi.local',
  cfo: 'cfo@gsi.local',
  financeTr: 'finance.tr@gsi.local',
  supervisorTr: 'supervisor.tr@gsi.local',
  inspectorTr: 'inspector.tr@gsi.local',
  inspector2Tr: 'inspector2.tr@gsi.local',
  supervisorRo: 'supervisor.ro@gsi.local',
  inspectorRo: 'inspector.ro@gsi.local',
};
