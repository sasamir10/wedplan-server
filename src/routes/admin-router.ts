import { Router, type Request } from 'express';
import type { Db } from 'mongodb';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorize.js';
import { enforceBlockStatus } from '../middleware/block-status.js';
import { getAdminStats } from '../services/admin-dashboard.service.js';
import {
  blockUser,
  getAdminUserDetails,
  listAdminUsers,
  parseListFilters,
  unblockUser,
} from '../services/admin-users.service.js';
import { AppError } from '../utils/app-error.js';

function requireActorId(request: Request): string {
  const actorId = request.authenticatedUser?.id;

  if (!actorId) {
    throw new AppError('Authentication required.', 401);
  }

  return actorId;
}

export function createAdminRouter(database: Db) {
  const router = Router();

  router.use(authenticate, authorizeRoles('admin'), enforceBlockStatus(database));

  router.get('/dashboard/stats', async (_request, response) => {
    const stats = await getAdminStats(database);
    response.status(200).json({ success: true, stats });
  });

  router.get('/users', async (request, response) => {
    const filters = parseListFilters(request.query);
    const result = await listAdminUsers(database, filters);
    response.status(200).json({ success: true, ...result });
  });

  router.get('/users/:userId', async (request, response) => {
    const user = await getAdminUserDetails(database, request.params.userId);
    response.status(200).json({ success: true, user });
  });

  router.patch('/users/:userId/block', async (request, response) => {
    const actorId = requireActorId(request);
    const result = await blockUser(
      database,
      actorId,
      request.params.userId,
    );
    response.status(200).json({ success: true, user: result });
  });

  router.patch('/users/:userId/unblock', async (request, response) => {
    const result = await unblockUser(database, request.params.userId);
    response.status(200).json({ success: true, user: result });
  });

  return router;
}
