import { Router, type Request } from 'express';
import type { Db } from 'mongodb';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorize.js';
import { getVendorStats } from '../services/vendor-dashboard.service.js';
import { AppError } from '../utils/app-error.js';

function requireVendorId(request: Request): string {
  const vendorId = request.authenticatedUser?.id;

  if (!vendorId) {
    throw new AppError('Authentication required.', 401);
  }

  return vendorId;
}

export function createVendorDashboardRouter(database: Db) {
  const router = Router();

  router.use(authenticate, authorizeRoles('vendor'));

  router.get('/dashboard/stats', async (request, response) => {
    const stats = await getVendorStats(database, requireVendorId(request));
    response.status(200).json({ success: true, stats });
  });

  return router;
}
