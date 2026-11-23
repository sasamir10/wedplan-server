import { Router, type Request, type RequestHandler } from 'express';
import type { Db } from 'mongodb';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorize.js';
import { enforceBlockStatus } from '../middleware/block-status.js';
import { AppError } from '../utils/app-error.js';
import {
  createSubscriptionCheckoutSession,
  scheduleVendorSubscriptionCancellation,
} from '../services/subscription.service.js';
import type { StripeClient } from '../services/stripe.service.js';

interface SubscriptionRouterOptions {
  /**
   * Isolated tests use this seam because the shared JWT middleware verifies
   * tokens against the live auth server's JWKS. Production callers omit it, so
   * every checkout request still runs the real authentication middleware.
   */
  authenticate?: RequestHandler;
  /**
   * Injected Stripe client for isolated tests. Production callers omit it, so
   * the live client from getStripe() is used.
   */
  stripeClient?: StripeClient;
}

function requireVendorId(request: Request): string {
  const vendorId = request.authenticatedUser?.id;

  if (!vendorId) {
    throw new AppError('Authentication required.', 401);
  }

  return vendorId;
}

export function createSubscriptionRouter(
  database: Db,
  options: SubscriptionRouterOptions = {},
) {
  const router = Router();
  const authenticateRequest = options.authenticate ?? authenticate;

  router.use(authenticateRequest, authorizeRoles('vendor'), enforceBlockStatus(database));

  router.post('/subscription/checkout', async (request, response) => {
    const vendorId = requireVendorId(request);

    // Client-supplied body fields are intentionally ignored. The vendor identity
    // is derived exclusively from the authenticated JWT subject.
    void request.body;

    const result = await createSubscriptionCheckoutSession(
      database,
      vendorId,
      options.stripeClient,
    );

    response.status(200).json({
      success: true,
      checkoutUrl: result.checkoutUrl,
      sessionId: result.sessionId,
    });
  });

  router.post('/subscription/cancel', async (request, response) => {
    const vendorId = requireVendorId(request);

    // Client-supplied body fields are intentionally ignored.
    void request.body;

    const result = await scheduleVendorSubscriptionCancellation(
      database,
      vendorId,
      options.stripeClient,
    );

    response.status(200).json({
      success: true,
      cancelled: result.cancelled,
      cancelAtPeriodEnd: result.cancelAtPeriodEnd,
      currentPeriodEnd: result.currentPeriodEnd,
      subscriptionStatus: result.subscriptionStatus,
    });
  });

  return router;
}
