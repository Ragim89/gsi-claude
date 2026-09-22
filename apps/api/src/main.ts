import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { migrate } from './db/migrate';
import { seed } from './db/seed';
import { seedReports } from './db/seed-reports';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  if (process.env.MIGRATE_ON_START === 'true') await migrate((m) => logger.log(m));
  if (process.env.SEED_ON_START === 'true') await seed();

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
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
  logger.log(`GSI API listening on :${config.port}/api`);

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
