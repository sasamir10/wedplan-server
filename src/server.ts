import { setServers } from 'node:dns';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { createAuth } from './config/auth.js';
import {
  closeDatabaseConnection,
  connectToDatabase,
  getMongoErrorDiagnostics,
  getMongoClient,
} from './config/database.js';
import { env } from './config/env.js';

let httpServer: Server | null = null;
let isShuttingDown = false;

async function closeHttpServer(): Promise<void> {
  if (!httpServer?.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    httpServer?.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function shutdown(signal: NodeJS.Signals | 'server error'): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.info(`Shutting down WedPlan server (${signal}).`);

  try {
    await closeHttpServer();
    await closeDatabaseConnection();
    console.info('WedPlan server shut down cleanly.');
  } catch {
    console.error('WedPlan server shutdown encountered an error.');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

async function startServer(): Promise<void> {
  try {
    if (env.NODE_ENV === 'development' && env.WEDPLAN_DNS_SERVERS) {
      setServers(env.WEDPLAN_DNS_SERVERS);
      console.info('Using the configured development DNS servers.');
    }

    const database = await connectToDatabase();

    if (isShuttingDown) {
      return;
    }

    const mongoClient = getMongoClient();
    const auth = createAuth(database, mongoClient);
    const app = createApp(auth, database, mongoClient);

    if (isShuttingDown) {
      return;
    }

    httpServer = app.listen(env.PORT, () => {
      console.info(`WedPlan server listening on port ${env.PORT} (${env.NODE_ENV}).`);
    });

    httpServer.on('error', (error: NodeJS.ErrnoException) => {
      console.error(`WedPlan HTTP server failed to start: ${error.message}`);
      process.exitCode = 1;
      void shutdown('server error');
    });
  } catch (error) {
    const originalError =
      typeof error === 'object' && error !== null && 'cause' in error && error.cause !== undefined
        ? error.cause
        : error;

    console.error('MongoDB connection diagnostics:', getMongoErrorDiagnostics(originalError));
    console.error(
      'WedPlan startup failed because the database connection could not be established. Check the MongoDB configuration and network access.',
    );
    process.exitCode = 1;
    await closeDatabaseConnection().catch(() => {
      console.error('MongoDB client cleanup failed during startup.');
    });
  }
}

void startServer();
