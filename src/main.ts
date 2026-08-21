import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const uploadDir = join(process.cwd(), 'uploads');
  if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });
  app.useStaticAssets(uploadDir, { prefix: '/uploads/' });

  const corsOrigins = new Set(
    (process.env.CORS_ORIGINS ?? 'http://localhost:3001,https://chatbot.doozi.bd')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (corsOrigins.has(origin)) return callback(null, true);
      try {
        const { hostname } = new URL(origin);
        if (
          hostname === 'localhost' ||
          hostname === '127.0.0.1' ||
          hostname === 'doozi.bd' ||
          hostname.endsWith('.doozi.bd')
        ) {
          return callback(null, true);
        }
      } catch {
        /* ignore invalid origin */
      }
      callback(null, false);
    },
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 4001;
  await app.listen(port);
  console.log(`Chatbot API running on http://localhost:${port}`);
}
bootstrap();
