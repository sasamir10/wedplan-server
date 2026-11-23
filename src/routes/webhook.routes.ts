import express from 'express';
import type { Db } from 'mongodb';
import type { StripeClient } from '../services/stripe.service.js';
import { AppError } from '../utils/app-error.js';
import { getStripe } from '../services/stripe.service.js';
import { toBetterAuthUserObjectId } from '../utils/object-id.js';

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
        await handleCheckoutSessionCompleted(stripeClient, database, event);
      }

      response.status(200).json({ success: true, received: true });
    },
  );

  return router;
}

interface StripeCheckoutSession {
  id: string;
  mode: string;
  subscription: string | null;
  customer: string | null;
  payment_status: string;
  metadata: Record<string, string>;
}

interface StripeSubscription {
  id: string;
  status: string;
  items: {
    data: Array<{
      price: { id: string };
    }>;
  };
  metadata: Record<string, string>;
}

async function handleCheckoutSessionCompleted(
  stripeClient: StripeClient,
  database: Db,
  event: { data: { object: unknown } },
): Promise<void> {
  const sessionObject = event.data.object as StripeCheckoutSession;

  if (sessionObject.mode !== 'subscription') {
    return;
  }

  if (!sessionObject.subscription || !sessionObject.customer) {
    return;
  }

  if (
    sessionObject.payment_status !== 'paid' &&
    sessionObject.payment_status !== 'no_payment_required'
  ) {
    return;
  }

  let subscription: StripeSubscription;
  try {
    subscription = (await stripeClient.subscriptions.retrieve(
      sessionObject.subscription,
    )) as StripeSubscription;
  } catch {
    return;
  }

  if (
    subscription.status !== 'active' &&
    subscription.status !== 'trialing'
  ) {
    return;
  }

  const hasPremiumPrice = subscription.items.data.some(
    (item) => item.price.id === process.env.STRIPE_PRICE_ID_PREMIUM,
  );

  if (!hasPremiumPrice) {
    return;
  }

  const sessionVendorId = sessionObject.metadata.vendorId;
  const subscriptionVendorId = subscription.metadata.vendorId;

  if (!sessionVendorId || !subscriptionVendorId) {
    return;
  }

  if (sessionVendorId !== subscriptionVendorId) {
    return;
  }

  const vendorObjectId = toBetterAuthUserObjectId(sessionVendorId);

  if (!vendorObjectId) {
    return;
  }

  const vendor = await database.collection('user').findOne({ _id: vendorObjectId });

  if (!vendor) {
    return;
  }

  if (vendor.role !== 'vendor') {
    return;
  }

  await database.collection('user').updateOne(
    { _id: vendorObjectId },
    { $set: { subscriptionPlan: 'premium' } },
  );
}
