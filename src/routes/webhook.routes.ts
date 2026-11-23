import express from 'express';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import type { StripeClient } from '../services/stripe.service.js';
import { AppError } from '../utils/app-error.js';
import { getStripe } from '../services/stripe.service.js';
import { toBetterAuthUserObjectId } from '../utils/object-id.js';
import type { TransactionDocument } from '../models/transaction.js';
import type { WebhookEventDocument } from '../models/webhook-event.js';

interface StripeWebhookRouterOptions {
  /**
   * Injected Stripe client for isolated tests. Production callers omit it,
   * so the live Stripe client from getStripe() is used.
   */
  stripeClient?: StripeClient;
  /**
   * Injected MongoDB client for transaction support. Production callers omit it,
   * so the live client is obtained from the application context.
   */
  client?: MongoClient;
}

export function createStripeWebhookRouter(
  database: Db,
  options: StripeWebhookRouterOptions = {},
) {
  const router = express.Router();
  const stripeClient = options.stripeClient ?? getStripe();
  const mongoClient = options.client;

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
        await handleCheckoutSessionCompleted(
          stripeClient,
          database,
          mongoClient,
          event,
        );
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
  amount_total: number;
  currency: string;
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
  mongoClient: MongoClient | undefined,
  event: { id: string; type: string; data: { object: unknown } },
): Promise<void> {
  const sessionObject = event.data.object as StripeCheckoutSession;
  const eventId = event.id as string;

  // Idempotency: if this event was already successfully processed, skip.
  const alreadyProcessed = await database
    .collection('webhook-events')
    .findOne({ stripeEventId: eventId, status: 'completed' });

  if (alreadyProcessed) {
    return;
  }

  // Early-exit validation checks — these are not errors, just events we
  // do not act upon. No database writes occur, so no transaction is needed.

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

  const vendor = await database.collection('user').findOne({
    _id: vendorObjectId,
  });

  if (!vendor) {
    return;
  }

  if (vendor.role !== 'vendor') {
    return;
  }

  // All verification checks passed. Use a MongoDB session transaction to
  // atomically record the webhook event, activate Premium, and insert the
  // payment transaction. If any operation fails, the transaction rolls back
  // and Stripe can safely retry.
  if (!mongoClient) {
    throw new AppError(
      'MongoDB client not available for transactional processing.',
      500,
      true,
      'MONGO_CLIENT_UNAVAILABLE',
    );
  }

  const session = mongoClient.startSession();

  try {
    await session.withTransaction(async () => {
      // Re-check inside the transaction to handle concurrent duplicate
      // deliveries. Another request may have completed processing while
      // this request was waiting for the session/locks.
      const concurrentProcessed = await database
        .collection('webhook-events')
        .findOne(
          { stripeEventId: eventId, status: 'completed' },
          { session },
        );

      if (concurrentProcessed) {
        return;
      }

      // Record the webhook event as pending. The unique index on
      // stripeEventId prevents duplicate processing across concurrent
      // requests — a duplicate-key error here means another request is
      // already handling this exact event.
      const webhookEvent: WebhookEventDocument = {
        _id: new ObjectId(),
        stripeEventId: eventId,
        eventType: event.type,
        status: 'pending',
        checkoutSessionId: sessionObject.id,
        vendorId: vendorObjectId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await database.collection('webhook-events').insertOne(webhookEvent, {
        session,
      });

      // Check if a transaction already exists for this Checkout Session.
      // If another request already processed a different event for the same
      // session, we mark our event as completed without creating a duplicate
      // transaction.
      const existingTransaction = await database
        .collection('transactions')
        .findOne(
          { stripeCheckoutSessionId: sessionObject.id },
          { session },
        );

      if (existingTransaction) {
        // Transaction already exists — mark our event as completed and skip
        // the Premium update and transaction insert (already done by the
        // other request).
        await database
          .collection('webhook-events')
          .updateOne(
            { stripeEventId: eventId },
            {
              $set: {
                status: 'completed',
                processedAt: new Date(),
                updatedAt: new Date(),
              },
            },
            { session },
          );
        return;
      }

      // Activate Premium subscription for the vendor.
      await database.collection('user').updateOne(
        { _id: vendorObjectId },
        { $set: { subscriptionPlan: 'premium' } },
        { session },
      );

      // Insert the payment transaction record. The unique index on
      // stripeCheckoutSessionId prevents duplicate transactions for the
      // same Checkout Session even across different event IDs.
      const transaction: TransactionDocument = {
        _id: new ObjectId(),
        vendorId: vendorObjectId,
        stripeCheckoutSessionId: sessionObject.id,
        stripeCustomerId: sessionObject.customer!,
        stripeSubscriptionId: sessionObject.subscription!,
        amount: sessionObject.amount_total,
        currency: sessionObject.currency,
        status: sessionObject.payment_status,
        createdAt: new Date(),
      };

      await database.collection('transactions').insertOne(transaction, {
        session,
      });

      // Mark the webhook event as successfully processed.
      await database
        .collection('webhook-events')
        .updateOne(
          { stripeEventId: eventId },
          {
            $set: {
              status: 'completed',
              processedAt: new Date(),
              updatedAt: new Date(),
            },
          },
          { session },
        );
    });
  } catch (error) {
    // withTransaction aborts automatically on error, rolling back all writes.
    // A duplicate-key error (code 11000) means a concurrent request won the
    // race on either the webhook-events or transactions unique index.
    const mongoError = error as { code?: number; name?: string };
    if (mongoError.code === 11000) {
      // Re-check whether this specific event was completed by the concurrent
      // request. Only return 200 if MongoDB confirms successful processing.
      const completed = await database
        .collection('webhook-events')
        .findOne({ stripeEventId: eventId, status: 'completed' });
      if (completed) {
        return;
      }
      // Event not confirmed as processed — return 500 so Stripe retries.
      // The retry will either find the completed event or process fresh.
      throw new AppError(
        'Webhook processing failed due to concurrent modification. Stripe will retry.',
        500,
        true,
        'WEBHOOK_CONCURRENT_MODIFICATION',
      );
    }

    throw new AppError(
      'Webhook processing failed. Stripe will retry.',
      500,
      true,
      'WEBHOOK_PROCESSING_FAILED',
    );
  } finally {
    await session.endSession();
  }
}
