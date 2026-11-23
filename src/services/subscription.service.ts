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
}

function vendorCollection(database: Db): Collection<VendorDocument> {
  return database.collection<VendorDocument>('user');
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
