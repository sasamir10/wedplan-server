import { Router, type Request } from 'express';
import type { Db, MongoClient } from 'mongodb';
import {
  createServiceSchema,
  updateAvailabilitySchema,
  updateServiceSchema,
} from '../models/service.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorize.js';
import {
  createService,
  deleteVendorService,
  getVendorServices,
  updateVendorService,
  updateVendorServiceAvailability,
} from '../services/service.service.js';
import { AppError } from '../utils/app-error.js';

function requireVendorId(request: Request): string {
  const vendorId = request.authenticatedUser?.id;

  if (!vendorId) {
    throw new AppError('Authentication required.', 401);
  }

  return vendorId;
}

function parseBody<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, body: unknown): T {
  const result = schema.safeParse(body);

  if (!result.success) {
    throw new AppError('Invalid service request. Check the submitted fields.', 400);
  }

  return result.data;
}

export function createVendorServicesRouter(database: Db, client: MongoClient) {
  const router = Router();

  router.use(authenticate, authorizeRoles('vendor'));

  router.post('/services', async (request, response) => {
    const input = parseBody(createServiceSchema, request.body);
    const service = await createService(database, client, requireVendorId(request), input);

    response.status(201).json({ success: true, service });
  });

  router.get('/services', async (request, response) => {
    const services = await getVendorServices(database, requireVendorId(request));

    response.status(200).json({ success: true, services });
  });

  router.patch('/services/:serviceId', async (request, response) => {
    const input = parseBody(updateServiceSchema, request.body);
    const service = await updateVendorService(
      database,
      requireVendorId(request),
      request.params.serviceId,
      input,
    );

    response.status(200).json({ success: true, service });
  });

  router.delete('/services/:serviceId', async (request, response) => {
    await deleteVendorService(
      database,
      client,
      requireVendorId(request),
      request.params.serviceId,
    );

    response.status(204).end();
  });

  router.patch('/services/:serviceId/availability', async (request, response) => {
    const input = parseBody(updateAvailabilitySchema, request.body);
    const service = await updateVendorServiceAvailability(
      database,
      client,
      requireVendorId(request),
      request.params.serviceId,
      input.availability,
    );

    response.status(200).json({ success: true, service });
  });

  return router;
}

