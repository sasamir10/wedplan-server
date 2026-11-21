import { Router, type RequestHandler } from 'express';
import type { Db } from 'mongodb';
import { authenticate } from '../middleware/authenticate.js';
import { enforceBlockStatus } from '../middleware/block-status.js';
import { publicServiceQuerySchema } from '../models/public-service.js';
import { AppError } from '../utils/app-error.js';
import {
  getPublicServiceById,
  listFeaturedPublicServices,
  listPublicServices,
} from '../services/public-service.service.js';

interface PublicServicesRouterOptions {
  /**
   * Isolated tests use this seam because the shared JWT middleware verifies
   * tokens against the live auth server's JWKS. Production callers omit it, so
   * every details request still runs the real authentication middleware.
   */
  authenticate?: RequestHandler;
}

export function createPublicServicesRouter(
  database: Db,
  options: PublicServicesRouterOptions = {},
) {
  const router = Router();
  const authenticateRequest = options.authenticate ?? authenticate;

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

  // Registered after the named routes so "/featured" is never read as an ID.
  router.get('/:id', authenticateRequest, enforceBlockStatus(database), async (request, response) => {
    const viewerId = request.authenticatedUser?.id;
    const serviceId = request.params.id;

    if (!viewerId) {
      throw new AppError(
        'Authentication required.',
        401,
        true,
        'AUTHENTICATION_REQUIRED',
      );
    }

    if (typeof serviceId !== 'string') {
      throw new AppError('Service not found.', 404, true, 'SERVICE_NOT_FOUND');
    }

    const service = await getPublicServiceById(database, serviceId, viewerId);

    response.status(200).json({ success: true, service });
  });

  return router;
}
