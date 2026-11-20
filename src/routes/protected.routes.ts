import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorize.js';

export const protectedRouter = Router();

protectedRouter.get('/protected', authenticate, (request, response) => {
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
});

protectedRouter.get(
  '/protected/customer',
  authenticate,
  authorizeRoles('customer'),
  (_request, response) => {
    response.status(200).json({
      success: true,
      message: 'Customer access granted.',
    });
  },
);

protectedRouter.get(
  '/protected/vendor',
  authenticate,
  authorizeRoles('vendor'),
  (_request, response) => {
    response.status(200).json({
      success: true,
      message: 'Vendor access granted.',
    });
  },
);

protectedRouter.get(
  '/protected/admin',
  authenticate,
  authorizeRoles('admin'),
  (_request, response) => {
    response.status(200).json({
      success: true,
      message: 'Admin access granted.',
    });
  },
);
