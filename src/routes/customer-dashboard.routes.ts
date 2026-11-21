import { Router, type Request } from 'express';
import type { Db } from 'mongodb';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorize.js';
import { getCustomerStats } from '../services/customer-dashboard.service.js';
import { AppError } from '../utils/app-error.js';

function requireCustomerId(request: Request): string {
  const customerId = request.authenticatedUser?.id;

  if (!customerId) {
    throw new AppError('Authentication required.', 401);
  }

  return customerId;
}

export function createCustomerDashboardRouter(database: Db) {
  const router = Router();

  router.use(authenticate, authorizeRoles('customer'));

  router.get('/dashboard/stats', async (request, response) => {
    const stats = await getCustomerStats(
      database,
      requireCustomerId(request),
    );
    response.status(200).json({ success: true, stats });
  });

  return router;
}
