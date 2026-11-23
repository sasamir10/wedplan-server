import {
  ObjectId,
  type Collection,
  type Db,
} from 'mongodb';
import { AppError } from '../utils/app-error.js';
import { toBetterAuthUserObjectId } from '../utils/object-id.js';
import { env } from '../config/env.js';
import { getStripe, type StripeClient } from './stripe.service.js';

interface VendorDocument {
  _id: ObjectId;
  role?: unknown;
  subscriptionPlan?: unknown;
  isBlocked?: unknown;
  stripeSubscriptionId?: unknown;
  stripeCustomerId?: unknown;
  subscriptionStatus?: unknown;
  subscriptionCancelAtPeriodEnd?: unknown;
  subscriptionCurrentPeriodEnd?: unknown;
}

function vendorCollection(database: Db): Collection<VendorDocument> {
  return database.collection<VendorDocument>('user');
}

interface StripeSubscriptionPeriodShape {
  current_period_end?: unknown;
  items?: {
    data?: Array<{
      current_period_end?: unknown;
    }>;
  };
}

/**
 * Reads the current billing period end from a Stripe subscription.
 *
 * Stripe moved current_period_end onto subscription items in newer API
 * versions, so both the legacy top-level field and the item-level field are
 * supported. Returns an ISO string because that is how lifecycle fields are
 * persisted in MongoDB.
 */
export function getSubscriptionPeriodEnd(
  subscription: unknown,
): string | undefined {
  const raw = subscription as StripeSubscriptionPeriodShape | null;

  if (!raw) {
    return undefined;
  }

  const seconds =
    typeof raw.current_period_end === 'number'
      ? raw.current_period_end
      : raw.items?.data?.[0]?.current_period_end;

  return typeof seconds === 'number'
    ? new Date(seconds * 1000).toISOString()
    : undefined;
}

export interface CreateCheckoutSessionResult {
  checkoutUrl: string;
  sessionId: string;
}

export async function createSubscriptionCheckoutSession(
  database: Db,
  vendorId: string,
  stripeClient?: StripeClient,
): Promise<CreateCheckoutSessionResult> {
  const vendorObjectId = toBetterAuthUserObjectId(vendorId);

  if (!vendorObjectId) {
    throw new AppError(
      'Vendor subscription could not be verified.',
      403,
      true,
      'VENDOR_NOT_FOUND',
    );
  }

  const vendor = await vendorCollection(database).findOne({
    _id: vendorObjectId,
  });

  if (!vendor) {
    throw new AppError(
      'Vendor subscription could not be verified.',
      403,
      true,
      'VENDOR_NOT_FOUND',
    );
  }

  if (vendor.role !== 'vendor') {
    throw new AppError(
      'Only vendors can initiate a subscription checkout.',
      403,
      true,
      'ROLE_FORBIDDEN',
    );
  }

  if (vendor.isBlocked) {
    throw new AppError(
      'Account access is unavailable.',
      403,
      true,
      'ACCOUNT_BLOCKED',
    );
  }

  if (vendor.subscriptionPlan === 'premium') {
    throw new AppError(
      'Your subscription is already active.',
      409,
      true,
      'ALREADY_PREMIUM',
    );
  }

  const stripe = stripeClient ?? getStripe();

  const successUrl = `${env.CLIENT_URL.replace(/\/$/, '')}/vendor/subscription/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${env.CLIENT_URL.replace(/\/$/, '')}/vendor/subscription/cancel`;

  let session: Awaited<ReturnType<StripeClient['checkout']['sessions']['create']>>;

  try {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        {
          price: env.STRIPE_PRICE_ID_PREMIUM,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        vendorId: vendorObjectId.toHexString(),
      },
      subscription_data: {
        metadata: {
          vendorId: vendorObjectId.toHexString(),
        },
      },
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      'Unable to create checkout session. Please try again.',
      502,
      true,
      'STRIPE_CHECKOUT_FAILED',
    );
  }

  if (!session.url) {
    throw new AppError(
      'Unable to create checkout session. Please try again.',
      502,
      true,
      'STRIPE_CHECKOUT_FAILED',
    );
  }

  return {
    checkoutUrl: session.url,
    sessionId: session.id,
  };
}

export interface CancelSubscriptionResult {
  cancelled: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: string;
  subscriptionStatus?: string;
}

/**
 * Schedules a vendor's Stripe subscription for cancellation at the end of the
 * current billing period. Vendor identity is derived exclusively from the
 * authenticated JWT subject — client-supplied IDs are never trusted.
 */
export async function scheduleVendorSubscriptionCancellation(
  database: Db,
  vendorId: string,
  stripeClient?: StripeClient,
): Promise<CancelSubscriptionResult> {
  const vendorObjectId = toBetterAuthUserObjectId(vendorId);

  if (!vendorObjectId) {
    throw new AppError(
      'Vendor subscription could not be verified.',
      403,
      true,
      'VENDOR_NOT_FOUND',
    );
  }

  const vendor = await vendorCollection(database).findOne({
    _id: vendorObjectId,
  });

  if (!vendor) {
    throw new AppError(
      'Vendor subscription could not be verified.',
      403,
      true,
      'VENDOR_NOT_FOUND',
    );
  }

  if (vendor.role !== 'vendor') {
    throw new AppError(
      'Only vendors can manage subscriptions.',
      403,
      true,
      'ROLE_FORBIDDEN',
    );
  }

  if (vendor.isBlocked) {
    throw new AppError(
      'Account access is unavailable.',
      403,
      true,
      'ACCOUNT_BLOCKED',
    );
  }

  const storedSubscriptionId =
    typeof vendor.stripeSubscriptionId === 'string'
      ? vendor.stripeSubscriptionId
      : null;

  if (!storedSubscriptionId) {
    throw new AppError(
      'No active subscription found.',
      404,
      true,
      'NO_SUBSCRIPTION',
    );
  }

  const stripe = stripeClient ?? getStripe();

  let stripeSubscription: Awaited<
    ReturnType<StripeClient['subscriptions']['retrieve']>
  >;

  try {
    stripeSubscription = await stripe.subscriptions.retrieve(
      storedSubscriptionId,
    );
  } catch {
    throw new AppError(
      'Unable to retrieve subscription from Stripe.',
      502,
      true,
      'STRIPE_RETRIEVE_FAILED',
    );
  }

  // Verify the subscription belongs to this vendor via metadata.
  const metadataVendorId = stripeSubscription.metadata?.vendorId;

  if (!metadataVendorId || metadataVendorId !== vendorObjectId.toHexString()) {
    throw new AppError(
      'Subscription does not belong to this vendor.',
      403,
      true,
      'SUBSCRIPTION_MISMATCH',
    );
  }

  if (stripeSubscription.cancel_at_period_end) {
    const currentPeriodEnd = getSubscriptionPeriodEnd(stripeSubscription);

    // Re-persist the scheduling details so a vendor whose local record is
    // missing the period end (for example, after a partial write) is repaired
    // without contacting Stripe again.
    await vendorCollection(database).updateOne(
      { _id: vendorObjectId },
      {
        $set: {
          subscriptionCancelAtPeriodEnd: true,
          ...(currentPeriodEnd
            ? { subscriptionCurrentPeriodEnd: currentPeriodEnd }
            : {}),
          subscriptionStatus: stripeSubscription.status,
          updatedAt: new Date(),
        },
      },
    );

    return {
      cancelled: false,
      cancelAtPeriodEnd: true,
      currentPeriodEnd,
      subscriptionStatus: stripeSubscription.status,
    };
  }

  if (
    stripeSubscription.status !== 'active' &&
    stripeSubscription.status !== 'trialing'
  ) {
    throw new AppError(
      'Subscription is not eligible for cancellation.',
      409,
      true,
      'SUBSCRIPTION_INELIGIBLE',
    );
  }

  let updated: Awaited<
    ReturnType<StripeClient['subscriptions']['update']>
  >;

  try {
    updated = await stripe.subscriptions.update(storedSubscriptionId, {
      cancel_at_period_end: true,
    });
  } catch {
    throw new AppError(
      'Unable to schedule cancellation. Please try again.',
      502,
      true,
      'STRIPE_CANCEL_FAILED',
    );
  }

  const currentPeriodEnd = getSubscriptionPeriodEnd(updated);

  await vendorCollection(database).updateOne(
    { _id: vendorObjectId },
    {
      $set: {
        subscriptionCancelAtPeriodEnd: true,
        ...(currentPeriodEnd
          ? { subscriptionCurrentPeriodEnd: currentPeriodEnd }
          : {}),
        subscriptionStatus: updated.status,
        updatedAt: new Date(),
      },
    },
  );

  return {
    cancelled: true,
    cancelAtPeriodEnd: true,
    currentPeriodEnd,
    subscriptionStatus: updated.status,
  };
}