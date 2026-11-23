import express from 'express';
import type { Db } from 'mongodb';
import type { StripeClient } from '../services/stripe.service.js';
import { AppError } from '../utils/app-error.js';
import { getStripe } from '../services/stripe.service.js';

interface StripeWebhookRouterOptions {
  /**
   * Injected Stripe client for isolated tests. Production callers omit it,
   * so the live Stripe client from getStripe() is used.
   */
  stripeClient?: StripeClient;
}

export function createStripeWebhookRouter(
  database: Db,
  options: StripeWebhookRouterOptions = {},
) {
  const router = express.Router();
  const stripeClient = options.stripeClient ?? getStripe();

  // Must be mounted before express.json() so the raw body buffer is available
  // for Stripe signature verification. express.json() would consume and parse
  // the body, making it impossible to verify the webhook signature.
  router.post(
    '/stripe',
    express.raw({ type: '*/*' }),
    async (request, response) => {
      const sig = request.headers['stripe-signature'] as string | undefined;

      if (!sig) {
        throw new AppError(
          'Missing stripe-signature header.',
          400,
          true,
          'MISSING_SIGNATURE',
        );
      }

      const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();

      if (!secret) {
        throw new AppError(
          'Webhook secret not configured.',
          500,
          true,
          'WEBHOOK_SECRET_MISSING',
        );
      }

      const payload = request.body as Buffer;

      let event;
      try {
        event = stripeClient.webhooks.constructEvent(payload, sig, secret);
      } catch {
        throw new AppError(
          'Invalid webhook signature or payload.',
          400,
          true,
          'INVALID_SIGNATURE',
        );
      }

      if (event.type === 'checkout.session.completed') {
        // Supported event type. Acknowledgment only; no subscription state
        // changes are performed here. Premium activation is handled in a later
        // step after verified webhook processing.
      }

      response.status(200).json({ success: true, received: true });
    },
  );

  return router;
}
