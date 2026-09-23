import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, createTestApp, login, SEED_PASSWORD } from './app';

describe('authentication', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('issues an access and a refresh token for valid credentials', async () => {
    const session = await login(app, ACCOUNTS.admin);
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
    expect(session.user.email).toBe(ACCOUNTS.admin);
    expect(session.user.role).toBe('admin');
    expect((session.user as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it('rejects a wrong password with the same message as an unknown e-mail', async () => {
    const wrongPassword = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: ACCOUNTS.admin, password: 'not-the-password' })
      .expect(401);
    const unknownUser = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'nobody@gsi.local', password: SEED_PASSWORD })
      .expect(401);
    // Identical wording: the response must not reveal which e-mails exist.
    expect(wrongPassword.body.message).toBe(unknownUser.body.message);
  });

  it('refuses any protected endpoint without a token', async () => {
    await request(app.getHttpServer()).get('/api/jobs').expect(401);
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
  });

  it('refuses a forged token', async () => {
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not.a.real.token')
      .expect(401);
  });

  it('will not accept a refresh token where an access token is expected', async () => {
    const session = await login(app, ACCOUNTS.admin);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${session.refreshToken}`)
      .expect(401);
  });

  it('exchanges a refresh token for a new session', async () => {
    const session = await login(app, ACCOUNTS.inspectorTr);
    const res = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toBe(ACCOUNTS.inspectorTr);
  });

  it('validates the request body instead of throwing', async () => {
    await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'not-an-email' }).expect(400);
    await request(app.getHttpServer()).post('/api/auth/login').send({}).expect(400);
  });

  it('answers the health check without authentication', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
  });
});
