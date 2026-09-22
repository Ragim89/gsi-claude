import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { migrate } from './db/migrate';
import { seed } from './db/seed';

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
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
