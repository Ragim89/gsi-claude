import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { assertProductionSafe, config } from './config';
import { migrate } from './db/migrate';
import { seed } from './db/seed';
import { seedReports } from './db/seed-reports';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  assertProductionSafe();

  if (process.env.MIGRATE_ON_START === 'true') await migrate((m) => logger.log(m));
  if (process.env.SEED_ON_START === 'true') await seed();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');

  // Security headers. The API serves JSON and PDFs, never HTML, so the content policies that
  // matter for a browser page are left to the web app's own nginx configuration.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  // Behind nginx / a load balancer: needed for correct client IPs in rate limiting and logs.
  app.set('trust proxy', 1);

  app.enableCors({ origin: config.corsOrigins, credentials: false });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  await app.listen(config.port);
  logger.log(`GSI API listening on :${config.port}/api (${config.env})`);
  if (config.rateLimit.disabled) logger.warn('rate limiting is DISABLED');

  // Demo only: render a sample of real PDF reports in the background once the API is up.
  const sample = Number(process.env.SEED_REPORTS ?? 0);
  if (sample > 0 && process.env.SEED_ON_START === 'true') {
    void seedReports(app, sample).catch((err) => logger.warn(`report seeding failed: ${err.message}`));
  }
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
