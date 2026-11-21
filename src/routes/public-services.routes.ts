import { Router } from 'express';
import type { Db } from 'mongodb';
import { publicServiceQuerySchema } from '../models/public-service.js';
import { AppError } from '../utils/app-error.js';
import {
  listFeaturedPublicServices,
  listPublicServices,
} from '../services/public-service.service.js';

export function createPublicServicesRouter(database: Db) {
  const router = Router();

  function parseQuery(query: unknown) {
    const result = publicServiceQuerySchema.safeParse(query);
    if (!result.success) {
      throw new AppError('Invalid service filters.', 400);
    }
    return result.data;
  }

  // Keep the named route before the collection route for clear route organization.
  router.get('/featured', async (_request, response) => {
    const services = await listFeaturedPublicServices(database);
    response.status(200).json({ success: true, services });
  });

  router.get('/', async (request, response) => {
    const services = await listPublicServices(database, parseQuery(request.query));
    response.status(200).json({ success: true, services });
  });

  return router;
}
