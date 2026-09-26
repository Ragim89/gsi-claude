import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, createTestApp, login, refreshCookieOf, SEED_PASSWORD } from './app';

describe('authentication', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('issues an access token and a session, and the refresh token is never in the body', async () => {
    const session = await login(app, ACCOUNTS.admin);
    expect(session.accessToken).toBeTruthy();
    expect((session as unknown as Record<string, unknown>).refreshToken).toBeUndefined();
    expect(session.user.email).toBe(ACCOUNTS.admin);
    expect(session.user.role).toBe('admin');
    expect((session.user as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it('sets the refresh token as an httpOnly, path-scoped cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: ACCOUNTS.admin, password: SEED_PASSWORD })
      .expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('gsi_rt='));
    expect(cookie).toBeTruthy();
    expect(cookie!.toLowerCase()).toContain('httponly');
    expect(cookie!).toContain('Path=/api/auth');
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

  it('will not accept the refresh cookie where an access token is expected', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: ACCOUNTS.admin, password: SEED_PASSWORD })
      .expect(200);
    const raw = refreshCookieOf(res);
    await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${raw}`).expect(401);
  });

  it('refuses to refresh with no cookie at all', async () => {
    await request(app.getHttpServer()).post('/api/auth/refresh').expect(401);
  });

  it('exchanges the refresh cookie for a new session and rotates it', async () => {
    const session = await login(app, ACCOUNTS.inspectorTr);
    const res = await session.agent.post('/api/auth/refresh').expect(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toBe(ACCOUNTS.inspectorTr);
    const rotated = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('gsi_rt='));
    expect(rotated).toBeTruthy();
  });

  it('validates the request body instead of throwing', async () => {
    await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'not-an-email' }).expect(400);
    await request(app.getHttpServer()).post('/api/auth/login').send({}).expect(400);
  });

  it('answers the health check without authentication', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  // ---- Session security (PHASE 12) ---------------------------------------------------------

  describe('refresh token rotation and reuse', () => {
    it('rejects the old refresh token once it has been rotated', async () => {
      const agent = request.agent(app.getHttpServer());
      const first = await agent
        .post('/api/auth/login')
        .send({ email: ACCOUNTS.inspector2Tr, password: SEED_PASSWORD })
        .expect(200);
      const oldRaw = refreshCookieOf(first);

      // Rotate through the agent, which sends and then updates its own cookie jar.
      await agent.post('/api/auth/refresh').expect(200);

      // Presenting the pre-rotation token again — what a stolen, already-used copy looks like —
      // is refused, not silently accepted as a second valid session.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', `gsi_rt=${oldRaw}`)
        .expect(401);
    });

    it('burns the whole token family on reuse, so even the newest token stops working', async () => {
      const login1 = await request(app.getHttpServer()).post('/api/auth/login')
        .send({ email: ACCOUNTS.analyst2Tr, password: SEED_PASSWORD }).expect(200);
      const firstRaw = refreshCookieOf(login1);

      const rotated1 = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', `gsi_rt=${firstRaw}`)
        .expect(200);
      const secondRaw = refreshCookieOf(rotated1);

      // Replay the already-rotated first token: detected as reuse.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', `gsi_rt=${firstRaw}`)
        .expect(401);

      // The legitimate, newest token from the same family is burned too — theft of an old
      // token invalidates the whole chain, not just the copy that was stolen.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', `gsi_rt=${secondRaw}`)
        .expect(401);
    });
  });

  describe('logout', () => {
    it('revokes the current session: the cookie stops refreshing after logout', async () => {
      const session = await login(app, ACCOUNTS.samplerTr);
      await session.agent.post('/api/auth/logout').expect(200);
      await session.agent.post('/api/auth/refresh').expect(401);
    });

    it('is idempotent and safe with no cookie at all', async () => {
      await request(app.getHttpServer()).post('/api/auth/logout').expect(200);
    });

    it('signs out every device on "log out everywhere"', async () => {
      // Two independent sessions for the same account (two devices).
      const deviceA = await login(app, ACCOUNTS.labTr);
      const deviceB = await login(app, ACCOUNTS.labTr);

      await deviceA.agent.post('/api/auth/logout-all')
        .set('Authorization', `Bearer ${deviceA.accessToken}`)
        .expect(200);

      await deviceA.agent.post('/api/auth/refresh').expect(401);
      await deviceB.agent.post('/api/auth/refresh').expect(401);
    });
  });

  describe('deactivated user', () => {
    it('denies refresh once the account is deactivated, even with a still-valid cookie', async () => {
      const admin = await login(app, ACCOUNTS.admin);
      const target = await login(app, ACCOUNTS.supervisorRo);

      const users = await request(app.getHttpServer())
        .get('/api/users')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      const row = (users.body.items ?? users.body).find((u: { email: string }) => u.email === ACCOUNTS.supervisorRo);
      expect(row).toBeTruthy();

      try {
        await request(app.getHttpServer())
          .patch(`/api/users/${row.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({ isActive: false })
          .expect(200);

        await target.agent.post('/api/auth/refresh').expect(401);
      } finally {
        // Restore the seed account so later tests (and re-runs) are unaffected.
        await request(app.getHttpServer())
          .patch(`/api/users/${row.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({ isActive: true })
          .expect(200);
      }
    });
  });
});
