import express from 'express';
import {
  ObjectId,
  type ClientSession,
  type Db,
  type MongoClient,
} from 'mongodb';
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

      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutSessionCompleted(
            stripeClient,
            database,
            mongoClient,
            event,
          );
          break;
        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(database, mongoClient, event);
          break;
        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(database, mongoClient, event);
          break;
        default:
          // Unrecognized events are acknowledged without database writes.
          break;
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

interface StripeSubscriptionItem {
  price?: { id?: string };
  /**
   * Stripe moved current_period_end onto subscription items in newer API
   * versions. The legacy top-level field is still read for compatibility.
   */
  current_period_end?: number;
}

interface StripeSubscription {
  id: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  customer?: string | { id?: string } | null;
  items?: {
    data?: StripeSubscriptionItem[];
  };
  metadata?: Record<string, string>;
}

interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

/** Returns the subscription period end in Unix seconds, if available. */
function subscriptionPeriodEndSeconds(
  subscription: StripeSubscription,
): number | null {
  if (typeof subscription.current_period_end === 'number') {
    return subscription.current_period_end;
  }

  const firstItem = subscription.items?.data?.[0];

  return typeof firstItem?.current_period_end === 'number'
    ? firstItem.current_period_end
    : null;
}

/** Converts Stripe Unix seconds to an ISO date string. */
function toIsoDate(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

/** Fast-path check used before doing any validation or Stripe calls. */
async function isWebhookEventCompleted(
  database: Db,
  eventId: string,
): Promise<boolean> {
  const completed = await database
    .collection('webhook-events')
    .findOne({ stripeEventId: eventId, status: 'completed' });

  return completed !== null;
}

/** Returns the Stripe customer ID whether the field is expanded or not. */
function subscriptionCustomerId(
  subscription: StripeSubscription,
): string | null {
  if (typeof subscription.customer === 'string') {
    return subscription.customer;
  }

  if (
    subscription.customer &&
    typeof subscription.customer === 'object' &&
    typeof subscription.customer.id === 'string'
  ) {
    return subscription.customer.id;
  }

  return null;
}

interface WebhookEventProcessingOptions {
  database: Db;
  mongoClient: MongoClient | undefined;
  eventId: string;
  eventType: string;
  checkoutSessionId?: string;
  vendorId: ObjectId;
  /**
   * Applies the event-specific writes. Every database call inside this
   * callback must use the provided MongoDB session so the whole webhook
   * event is committed or rolled back atomically.
   */
  apply: (session: ClientSession) => Promise<void>;
}

/**
 * Processes a verified Stripe webhook event exactly once.
 *
 * Idempotency layers:
 * 1. Fast path: skip events already recorded as completed.
 * 2. Inside the transaction: re-check completion to handle concurrent
 *    deliveries, then insert the event. The unique index on stripeEventId
 *    makes concurrent inserts fail closed.
 * 3. The event is marked completed only after all event-specific writes
 *    succeed within the same transaction.
 *
 * Genuine failures return a retryable 500 so Stripe delivers the event again.
 */
async function processWebhookEvent(
  options: WebhookEventProcessingOptions,
): Promise<void> {
  const {
    database,
    mongoClient,
    eventId,
    eventType,
    checkoutSessionId,
    vendorId,
    apply,
  } = options;

  const alreadyProcessed = await database
    .collection('webhook-events')
    .findOne({ stripeEventId: eventId, status: 'completed' });

  if (alreadyProcessed) {
    return;
  }

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
        eventType,
        status: 'pending',
        ...(checkoutSessionId ? { checkoutSessionId } : {}),
        vendorId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await database.collection('webhook-events').insertOne(webhookEvent, {
        session,
      });

      await apply(session);

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

async function handleCheckoutSessionCompleted(
  stripeClient: StripeClient,
  database: Db,
  mongoClient: MongoClient | undefined,
  event: StripeWebhookEvent,
): Promise<void> {
  const sessionObject = event.data.object as StripeCheckoutSession;
  const eventId = event.id;

  // Fast path: duplicate deliveries of an already completed event are
  // acknowledged without validation or Stripe API calls.
  if (await isWebhookEventCompleted(database, eventId)) {
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

  let subscription: StripeSubscription | null;
  try {
    subscription = (await stripeClient.subscriptions.retrieve(
      sessionObject.subscription,
    )) as StripeSubscription | null;
  } catch {
    return;
  }

  if (!subscription) {
    return;
  }

  if (
    subscription.status !== 'active' &&
    subscription.status !== 'trialing'
  ) {
    return;
  }

  const hasPremiumPrice = subscription.items?.data?.some(
    (item) => item.price?.id === process.env.STRIPE_PRICE_ID_PREMIUM,
  );

  if (!hasPremiumPrice) {
    return;
  }

  const sessionVendorId = sessionObject.metadata.vendorId;
  const subscriptionVendorId = subscription.metadata?.vendorId;

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

  const periodEnd = toIsoDate(subscriptionPeriodEndSeconds(subscription));
  const stripeCustomerId =
    subscriptionCustomerId(subscription) ?? sessionObject.customer;

  // All verification checks passed. Use a MongoDB session transaction to
  // atomically record the webhook event, activate Premium, and insert the
  // payment transaction. If any operation fails, the transaction rolls back
  // and Stripe can safely retry.
  await processWebhookEvent({
    database,
    mongoClient,
    eventId,
    eventType: event.type,
    checkoutSessionId: sessionObject.id,
    vendorId: vendorObjectId,
    apply: async (session) => {
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
        // Transaction already exists — skip the Premium update and
        // transaction insert (already done by the other request).
        return;
      }

      // Activate Premium and persist the subscription identity required by
      // later lifecycle webhooks and the cancellation endpoint. Premium is
      // only ever activated here, after a verified checkout.
      await database.collection('user').updateOne(
        { _id: vendorObjectId },
        {
          $set: {
            subscriptionPlan: 'premium',
            stripeSubscriptionId: subscription.id,
            stripeCustomerId,
            subscriptionStatus: subscription.status,
            subscriptionCancelAtPeriodEnd:
              subscription.cancel_at_period_end === true,
            ...(periodEnd
              ? { subscriptionCurrentPeriodEnd: periodEnd }
              : {}),
            updatedAt: new Date(),
          },
        },
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
    },
  });
}

interface SubscriptionVendor {
  vendorObjectId: ObjectId;
}

/**
 * Resolves the vendor for a subscription event using trusted server-created
 * metadata, then confirms the event belongs to the vendor's current
 * subscription. Stale events for replaced subscriptions are ignored.
 */
async function findSubscriptionVendor(
  database: Db,
  subscription: StripeSubscription,
): Promise<SubscriptionVendor | null> {
  const vendorId = subscription.metadata?.vendorId;

  if (!vendorId) {
    return null;
  }

  const vendorObjectId = toBetterAuthUserObjectId(vendorId);

  if (!vendorObjectId) {
    return null;
  }

  const vendor = await database.collection('user').findOne({
    _id: vendorObjectId,
  });

  if (!vendor || vendor.role !== 'vendor') {
    return null;
  }

  if (
    typeof vendor.stripeSubscriptionId !== 'string' ||
    vendor.stripeSubscriptionId !== subscription.id
  ) {
    return null;
  }

  return { vendorObjectId };
}

/**
 * Handles customer.subscription.updated.
 *
 * This event keeps lifecycle metadata in sync (status, cancellation
 * scheduling, current period end) but never activates Premium. Premium is
 * activated exclusively by a verified checkout completion. When
 * cancel_at_period_end is true, the vendor remains Premium until Stripe
 * confirms the subscription actually ended.
 */
async function handleSubscriptionUpdated(
  database: Db,
  mongoClient: MongoClient | undefined,
  event: StripeWebhookEvent,
): Promise<void> {
  const subscription = event.data.object as StripeSubscription;

  if (!subscription || typeof subscription.id !== 'string') {
    return;
  }

  if (await isWebhookEventCompleted(database, event.id)) {
    return;
  }

  const vendor = await findSubscriptionVendor(database, subscription);

  if (!vendor) {
    return;
  }

  const periodEnd = toIsoDate(subscriptionPeriodEndSeconds(subscription));

  await processWebhookEvent({
    database,
    mongoClient,
    eventId: event.id,
    eventType: event.type,
    vendorId: vendor.vendorObjectId,
    apply: async (session) => {
      await database.collection('user').updateOne(
        {
          _id: vendor.vendorObjectId,
          stripeSubscriptionId: subscription.id,
        },
        {
          $set: {
            subscriptionStatus: subscription.status,
            subscriptionCancelAtPeriodEnd:
              subscription.cancel_at_period_end === true,
            ...(periodEnd
              ? { subscriptionCurrentPeriodEnd: periodEnd }
              : {}),
            updatedAt: new Date(),
          },
        },
        { session },
      );
    },
  });
}

/**
 * Handles customer.subscription.deleted.
 *
 * Stripe has confirmed the subscription actually ended, so the vendor is
 * downgraded to Free. Historical transaction records are never modified.
 * Events for a replaced subscription are ignored.
 */
async function handleSubscriptionDeleted(
  database: Db,
  mongoClient: MongoClient | undefined,
  event: StripeWebhookEvent,
): Promise<void> {
  const subscription = event.data.object as StripeSubscription;

  if (!subscription || typeof subscription.id !== 'string') {
    return;
  }

  if (await isWebhookEventCompleted(database, event.id)) {
    return;
  }

  const vendor = await findSubscriptionVendor(database, subscription);

  if (!vendor) {
    return;
  }

  const periodEnd = toIsoDate(subscriptionPeriodEndSeconds(subscription));

  await processWebhookEvent({
    database,
    mongoClient,
    eventId: event.id,
    eventType: event.type,
    vendorId: vendor.vendorObjectId,
    apply: async (session) => {
      await database.collection('user').updateOne(
        {
          _id: vendor.vendorObjectId,
          stripeSubscriptionId: subscription.id,
        },
        {
          $set: {
            subscriptionPlan: 'free',
            subscriptionStatus: subscription.status || 'canceled',
            subscriptionCancelAtPeriodEnd: false,
            subscriptionCurrentPeriodEnd: periodEnd,
            // Clear the replaced subscription identity so later events for
            // the ended subscription cannot affect this vendor again.
            stripeSubscriptionId: null,
            updatedAt: new Date(),
          },
        },
        { session },
      );
    },
  });
}
