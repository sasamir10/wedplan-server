import { Router } from 'express';
import type { Db } from 'mongodb';
import {
  adminServiceQuerySchema,
  adminServiceStatusSchema,
  emptyAdminServiceBodySchema,
} from '../models/admin-service.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorize.js';
import {
  approvePendingService,
  deleteAdminService,
  listAdminServices,
  rejectPendingService,
  updateAdminServiceStatus,
} from '../services/admin-service.service.js';
import { AppError } from '../utils/app-error.js';

function parseBody<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  body: unknown,
): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new AppError('Invalid admin service request.', 400);
  }
  return result.data;
}

function parseQuery(requestQuery: unknown) {
  const result = adminServiceQuerySchema.safeParse(requestQuery);
  if (!result.success) {
    throw new AppError('Invalid service filters or pagination values.', 400);
  }
  return result.data;
}

export function createAdminServicesRouter(database: Db) {
  const router = Router();

  router.use(authenticate, authorizeRoles('admin'));

  router.get('/services', async (request, response) => {
    const query = parseQuery(request.query);
    const result = await listAdminServices(database, query);
    response.status(200).json({ success: true, ...result });
  });

  router.patch('/services/:serviceId/approve', async (request, response) => {
    parseBody(emptyAdminServiceBodySchema, request.body);
    const service = await approvePendingService(database, request.params.serviceId);
    response.status(200).json({ success: true, service });
  });

  router.patch('/services/:serviceId/reject', async (request, response) => {
    parseBody(emptyAdminServiceBodySchema, request.body);
    const service = await rejectPendingService(database, request.params.serviceId);
    response.status(200).json({ success: true, service });
  });

  router.patch('/services/:serviceId/status', async (request, response) => {
    const input = parseBody(adminServiceStatusSchema, request.body);
    const service = await updateAdminServiceStatus(
      database,
      request.params.serviceId,
      input.status,
    );
    response.status(200).json({ success: true, service });
  });

  router.delete('/services/:serviceId', async (request, response) => {
    await deleteAdminService(database, request.params.serviceId);
    response.status(204).end();
  });

  return router;
}
