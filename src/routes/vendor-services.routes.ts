import { Router, type Request } from 'express';
import type { Db, MongoClient } from 'mongodb';
import {
  createServiceSchema,
  updateAvailabilitySchema,
  updateServiceSchema,
} from '../models/service.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorize.js';
import { enforceBlockStatus } from '../middleware/block-status.js';
import { receiveImageUpload } from '../middleware/image-upload.js';
import { env } from '../config/env.js';
import {
  createService,
  deleteVendorService,
  getVendorServices,
  updateVendorService,
  updateVendorServiceAvailability,
} from '../services/service.service.js';
import { uploadImageToImgBB } from '../services/image-upload.service.js';
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

  router.use(authenticate, authorizeRoles('vendor'), enforceBlockStatus(database));

  router.post(
    '/services/upload-image',
    (_request, _response, next) => {
      if (!env.IMGBB_API_KEY) {
        return next(new AppError('Image uploads are not configured.', 503));
      }

      return next();
    },
    receiveImageUpload,
    async (request, response) => {
      const image = request.uploadedImage;
      if (!image) {
        throw new AppError('An image file is required.', 400);
      }

      const uploadedImage = await uploadImageToImgBB(image, env.IMGBB_API_KEY);
      response.status(201).json({ success: true, image: uploadedImage });
    },
  );

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

