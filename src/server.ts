import app from './app.js';
import { env } from './config/env.js';

const server = app.listen(env.PORT, () => {
  console.info(`WedPlan server listening on port ${env.PORT} (${env.NODE_ENV})`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error('Failed to start WedPlan server:', error.message);
  process.exitCode = 1;
});
