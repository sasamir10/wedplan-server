import cors from 'cors';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import helmet from 'helmet';
import type { Db, MongoClient } from 'mongodb';
import type { WedPlanAuth } from './config/auth.js';
import { env } from './config/env.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { healthRouter } from './routes/health.routes.js';
import { protectedRouter } from './routes/protected.routes.js';
import { createAdminServicesRouter } from './routes/admin-services.routes.js';
import { createVendorServicesRouter } from './routes/vendor-services.routes.js';

export function createApp(auth: WedPlanAuth, database: Db, client: MongoClient) {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_URL,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  app.all('/api/auth/{*path}', toNodeHandler(auth));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use('/api', healthRouter);
  app.use('/api', protectedRouter);
  app.use('/api/admin', createAdminServicesRouter(database));
  app.use('/api/vendor', createVendorServicesRouter(database, client));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
