import Stripe from 'stripe';
import { env } from '../config/env.js';

let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeClient) {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error('Missing required configuration: STRIPE_SECRET_KEY');
    }
    stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-11-18.endive',
      typescript: true,
    });
  }
  return stripeClient;
}

export type StripeClient = Stripe;
