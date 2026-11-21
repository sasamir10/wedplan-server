import { Router, type Request } from 'express';
import type { Db } from 'mongodb';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorize.js';
import { enforceBlockStatus } from '../middleware/block-status.js';

export function createProtectedRouter(database: Db) {
  const router = Router();

  router.get(
    '/protected',
    authenticate,
    enforceBlockStatus(database),
    (request, response) => {
      const user = request.authenticatedUser;

      if (!user) {
        response.status(401).json({
          success: false,
          error: { message: 'Authentication required.' },
        });
        return;
      }

      response.status(200).json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          isBlocked: user.isBlocked,
        },
      });
    },
  );

  router.get(
    '/protected/customer',
    authenticate,
    authorizeRoles('customer'),
    enforceBlockStatus(database),
    (_request, response) => {
      response.status(200).json({
        success: true,
        message: 'Customer access granted.',
      });
    },
  );

  router.get(
    '/protected/vendor',
    authenticate,
    authorizeRoles('vendor'),
    enforceBlockStatus(database),
    (_request, response) => {
      response.status(200).json({
        success: true,
        message: 'Vendor access granted.',
      });
    },
  );

  router.get(
    '/protected/admin',
    authenticate,
    authorizeRoles('admin'),
    enforceBlockStatus(database),
    (_request, response) => {
      response.status(200).json({
        success: true,
        message: 'Admin access granted.',
      });
    },
  );

  return router;
}
