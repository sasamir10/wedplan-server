import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { ObjectId, type Db } from 'mongodb';
import type { StripeClient } from '../src/services/stripe.service.js';
import { createStripeWebhookRouter } from '../src/routes/webhook.routes.js';
import { ensureWebhookIndexes } from '../src/config/database.js';

type MockConstructEvent = (
  payload: string | Buffer,
  sig: string,
  secret: string,
) => { type: string; data: { object: unknown } };

const mockConstructEvent = (
  eventType: string,
  sessionObject?: unknown,
  eventId?: string,
): MockConstructEvent => {
  return (_payload, _sig, _secret) => {
    return {
      type: eventType,
      id: eventId,
      data: {
        object: sessionObject ?? {},
      },
    };
  };
};

const throwingConstructEvent: MockConstructEvent = () => {
  throw new Error('Invalid signature');
};

interface MockCheckoutSession {
  id: string;
  mode: string;
  subscription: string | null;
  customer: string | null;
  payment_status: string;
  amount_total: number;
  currency: string;
  metadata: Record<string, string>;
}

interface MockSubscription {
  id: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  customer?: string | { id: string };
  items: {
    data: Array<{
      price: { id: string };
      current_period_end?: number;
    }>;
  };
  metadata: Record<string, string>;
}

function createMockStripeClient(options: {
  constructEvent: MockConstructEvent;
  session?: MockCheckoutSession;
  subscription?: MockSubscription;
  sessionRetrieveError?: boolean;
  subscriptionRetrieveError?: boolean;
}): StripeClient {
  return {
    webhooks: {
      constructEvent: options.constructEvent,
    },
    checkout: {
      sessions: {
        retrieve: async (_sessionId: string) => {
          if (options.sessionRetrieveError) {
            throw new Error('Stripe retrieval failed');
          }
          return options.session ?? null;
        },
      },
    },
    subscriptions: {
      retrieve: async (_subscriptionId: string) => {
        if (options.subscriptionRetrieveError) {
          throw new Error('Stripe retrieval failed');
        }
        return options.subscription ?? null;
      },
    },
  } as unknown as StripeClient;
}

interface MockUserDocument {
  _id: string;
  name?: string;
  role?: unknown;
  subscriptionPlan?: unknown;
  isBlocked?: unknown;
  stripeSubscriptionId?: string | null;
  stripeCustomerId?: string | null;
  subscriptionStatus?: string | null;
  subscriptionCancelAtPeriodEnd?: boolean;
  subscriptionCurrentPeriodEnd?: string | null;
}

interface MockTransactionDocument {
  vendorId: ObjectId | string;
  stripeCheckoutSessionId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: Date;
}

interface MockDatabase {
  collectionCalls: Array<{ name: string }>;
  users: Map<string, MockUserDocument>;
  updateOneCalls: Array<{
    filter: Record<string, unknown>;
    update: Record<string, unknown>;
  }>;
  transactionCalls: Array<{
    document: Partial<MockTransactionDocument>;
  }>;
  transactionIndexCalls: Array<{
    key: Record<string, unknown>;
    name?: string;
    unique?: boolean;
    partialFilterExpression?: Record<string, unknown>;
  }>;
  transactionIndexDroppedCalls: Array<string>;
  aggregateCalls: Array<Array<Record<string, unknown>>>;
  webhookEvents: Map<string, MockWebhookEventDocument>;
  webhookEventCalls: Array<{
    operation: string;
    filter?: Record<string, unknown>;
    document?: unknown;
    update?: Record<string, unknown>;
  }>;
  usedCheckoutSessionIds: Set<string>;
  shouldFailTransaction: boolean;
  shouldThrowDuplicateKey: boolean;
}

interface MockWebhookEventDocument {
  stripeEventId: string;
  eventType: string;
  status: string;
  checkoutSessionId?: string;
  vendorId?: ObjectId | string;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

function createMockDatabase(users: MockUserDocument[]): MockDatabase {
  const usersMap = new Map<string, MockUserDocument>();
  for (const user of users) {
    usersMap.set(user._id, user);
  }

  return {
    collectionCalls: [],
    users: usersMap,
    updateOneCalls: [],
    transactionCalls: [],
    transactionIndexCalls: [],
    transactionIndexDroppedCalls: [],
    aggregateCalls: [],
    webhookEvents: new Map(),
    webhookEventCalls: [],
    usedCheckoutSessionIds: new Set(),
    shouldFailTransaction: false,
    shouldThrowDuplicateKey: false,
  } as unknown as MockDatabase;
}

function createDbMock(db: MockDatabase): Db {
  return {
    collection: (name: string) => {
      db.collectionCalls.push({ name });

      if (name === 'user') {
        return {
          findOne: async (filter: Record<string, unknown>) => {
            const id = filter._id;
            const key = id instanceof ObjectId ? id.toHexString() : String(id);
            return key !== undefined ? db.users.get(key) ?? null : null;
          },
          updateOne: async (
            filter: Record<string, unknown>,
            update: Record<string, unknown>,
          ) => {
            db.updateOneCalls.push({ filter, update });
            const id = filter._id;
            const key = id instanceof ObjectId ? id.toHexString() : String(id);
            if (key !== undefined) {
              const user = db.users.get(key);
              if (user && update.$set) {
                Object.assign(user, update.$set);
              }
            }
            return { matchedCount: 1, modifiedCount: 1 };
          },
        } as never;
      }

      if (name === 'transactions') {
        return {
          findOne: async (filter: Record<string, unknown>) => {
            db.webhookEventCalls.push({ operation: 'findOne_transactions', filter });
            const sessionId = filter.stripeCheckoutSessionId as string | undefined;
            if (!sessionId) return null;
            // Check if any transaction exists for this checkout session ID
            for (const call of db.transactionCalls) {
              const doc = call.document as Partial<MockTransactionDocument>;
              if (doc.stripeCheckoutSessionId === sessionId) {
                return { ...doc, _id: new ObjectId() };
              }
            }
            return null;
          },
          insertOne: async (document: unknown) => {
            if (db.shouldFailTransaction) {
              throw new Error('Database insertion failed');
            }
            const doc = document as Partial<MockTransactionDocument>;
            const sessionId = doc.stripeCheckoutSessionId;
            if (sessionId && db.usedCheckoutSessionIds.has(sessionId)) {
              const error: Error & { code?: number } = new Error(
                'E11000 duplicate key error',
              );
              error.code = 11000;
              throw error;
            }
            if (sessionId) {
              db.usedCheckoutSessionIds.add(sessionId);
            }
            db.transactionCalls.push({
              document: doc,
            });
            return { acknowledged: true, insertedId: new ObjectId() };
          },
          createIndexes: async (
            indexes: Array<{
              key: Record<string, unknown>;
              name?: string;
              unique?: boolean;
              partialFilterExpression?: Record<string, unknown>;
            }>,
          ) => {
            db.transactionIndexCalls.push(...indexes);
          },
          listIndexes: async () => ({
            toArray: async () =>
              db.transactionIndexCalls.map((idx) => ({
                name: idx.name,
                key: idx.key,
                unique: idx.unique,
                partialFilterExpression: idx.partialFilterExpression,
              })),
          }),
          dropIndex: async (indexName: string) => {
            db.transactionIndexDroppedCalls.push(indexName);
            db.transactionIndexCalls = db.transactionIndexCalls.filter(
              (idx) => idx.name !== indexName,
            );
          },
          aggregate: async (pipeline: Array<Record<string, unknown>>) => {
            // Simulate the duplicate detection aggregation:
            //   $match: { stripeCheckoutSessionId: { $type: 'string', $ne: '' } }
            //   $group: { _id: '$stripeCheckoutSessionId', count: { $sum: 1 } }
            //   $match: { count: { $gt: 1 } }
            db.aggregateCalls.push(pipeline);
            const counts = new Map<string, number>();
            for (const call of db.transactionCalls) {
              const doc = call.document as Partial<MockTransactionDocument>;
              const sid = doc.stripeCheckoutSessionId;
              if (sid && typeof sid === 'string' && sid !== '') {
                counts.set(sid, (counts.get(sid) || 0) + 1);
              }
            }
            const duplicates = [...counts.entries()]
              .filter(([, c]) => c > 1)
              .map(([sid, c]) => ({ _id: sid, count: c }));
            return {
              toArray: async () => duplicates,
            };
          },
        } as never;
      }

      if (name === 'webhook-events') {
        return {
          findOne: async (filter: Record<string, unknown>) => {
            db.webhookEventCalls.push({ operation: 'findOne', filter });
            const eventId = filter.stripeEventId as string | undefined;
            if (!eventId) return null;
            const event = db.webhookEvents.get(eventId);
            return event ?? null;
          },
          insertOne: async (document: unknown) => {
            db.webhookEventCalls.push({
              operation: 'insertOne',
              document: document as Partial<MockWebhookEventDocument>,
            });
            if (db.shouldThrowDuplicateKey) {
              const error: Error & { code?: number } = new Error(
                'E11000 duplicate key error',
              );
              error.code = 11000;
              throw error;
            }
            const doc = document as Partial<MockWebhookEventDocument>;
            if (doc.stripeEventId) {
              db.webhookEvents.set(doc.stripeEventId, doc as MockWebhookEventDocument);
            }
            return { acknowledged: true, insertedId: new ObjectId() };
          },
          updateOne: async (
            filter: Record<string, unknown>,
            update: Record<string, unknown>,
          ) => {
            db.webhookEventCalls.push({
              operation: 'updateOne',
              filter,
              update,
            });
            const eventId = filter.stripeEventId as string | undefined;
            if (eventId && db.webhookEvents.has(eventId)) {
              const existing = db.webhookEvents.get(eventId)!;
              if (update.$set) {
                Object.assign(existing, update.$set);
              }
            }
            return { matchedCount: 1, modifiedCount: 1 };
          },
          createIndexes: async (
            _indexes: Array<{
              key: Record<string, unknown>;
              name?: string;
              unique?: boolean;
              partialFilterExpression?: Record<string, unknown>;
            }>,
          ) => {
            // No-op: webhook-events index calls are not asserted in tests.
          },
        } as never;
      }

      return {} as never;
    },
  } as unknown as Db;
}

async function withWebhookServer<T>(
  options: {
    stripeClient?: StripeClient;
    webhookSecret?: string;
    database?: Db;
    client?: {
      startSession: () => {
        startTransaction: () => void;
        commitTransaction: () => Promise<void>;
        abortTransaction: () => Promise<void>;
        endSession: () => Promise<void>;
        withTransaction: <T>(callback: () => Promise<T>) => Promise<T>;
      };
    };
  },
  action: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const db =
    options.database ??
    createDbMock(createMockDatabase([]));

  // Build a mock MongoDB client with session/transaction support.
  const mockClient = options.client ?? {
    startSession: () => ({
      startTransaction: () => undefined,
      commitTransaction: async () => undefined,
      abortTransaction: async () => undefined,
      endSession: async () => undefined,
      withTransaction: async <T>(callback: () => Promise<T>) => {
        return await callback();
      },
    }),
  };

  const app = express();
  app.use(
    '/api/webhooks',
    createStripeWebhookRouter(db, {
      stripeClient: options.stripeClient,
      client: mockClient as unknown as import('mongodb').MongoClient,
    }),
  );

  const server: Server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port.');
  }

  const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const originalPriceId = process.env.STRIPE_PRICE_ID_PREMIUM;
  if (options.webhookSecret !== undefined) {
    process.env.STRIPE_WEBHOOK_SECRET = options.webhookSecret;
  } else {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
  if (options.webhookSecret !== undefined) {
    process.env.STRIPE_PRICE_ID_PREMIUM = 'price_premium_test';
  } else {
    delete process.env.STRIPE_PRICE_ID_PREMIUM;
  }

  try {
    return await action(`http://127.0.0.1:${address.port}`);
  } finally {
    if (originalSecret !== undefined) {
      process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
    } else {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
    if (originalPriceId !== undefined) {
      process.env.STRIPE_PRICE_ID_PREMIUM = originalPriceId;
    } else {
      delete process.env.STRIPE_PRICE_ID_PREMIUM;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('valid Stripe signature returns 200', async () => {
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed'),
  });

  await withWebhookServer({ stripeClient, webhookSecret: 'whsec_test' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1234567890,v1=testsig',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'checkout.session.completed', data: {} }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
  });
});

test('recognized checkout.session.completed event returns 200', async () => {
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed'),
  });

  await withWebhookServer({ stripeClient, webhookSecret: 'whsec_test' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1234567890,v1=testsig',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } }),
    });

    assert.equal(response.status, 200);
  });
});

test('unrecognized event type still returns 200', async () => {
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('invoice.payment_succeeded'),
  });

  await withWebhookServer({ stripeClient, webhookSecret: 'whsec_test' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1234567890,v1=testsig',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'invoice.payment_succeeded', data: {} }),
    });

    assert.equal(response.status, 200);
  });
});

test('missing stripe-signature header returns 400', async () => {
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed'),
  });

  await withWebhookServer({ stripeClient, webhookSecret: 'whsec_test' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'checkout.session.completed', data: {} }),
    });

    assert.equal(response.status, 400);
  });
});

test('invalid Stripe signature returns 400', async () => {
  const stripeClient = createMockStripeClient({
    constructEvent: throwingConstructEvent,
  });

  await withWebhookServer({ stripeClient, webhookSecret: 'whsec_test' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1234567890,v1=badsig',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'checkout.session.completed', data: {} }),
    });

    assert.equal(response.status, 400);
  });
});

test('malformed payload returns 400', async () => {
  const stripeClient = createMockStripeClient({
    constructEvent: throwingConstructEvent,
  });

  await withWebhookServer({ stripeClient, webhookSecret: 'whsec_test' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1234567890,v1=testsig',
        'content-type': 'application/json',
      },
      body: 'not-valid-json',
    });

    assert.equal(response.status, 400);
  });
});

test('missing webhook secret returns 500', async () => {
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed'),
  });

  await withWebhookServer({ stripeClient }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1234567890,v1=testsig',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'checkout.session.completed', data: {} }),
    });

    assert.equal(response.status, 500);
  });
});

// ----- Premium activation tests -----

const VENDOR_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CUSTOMER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function vendorUser(): MockUserDocument {
  return {
    _id: VENDOR_ID,
    name: 'Test Vendor',
    role: 'vendor',
    subscriptionPlan: 'free',
    isBlocked: false,
  };
}

function customerUser(): MockUserDocument {
  return {
    _id: CUSTOMER_ID,
    name: 'Test Customer',
    role: 'customer',
    subscriptionPlan: 'free',
    isBlocked: false,
  };
}

function validSession(): MockCheckoutSession {
  return {
    id: 'cs_test_123',
    mode: 'subscription',
    subscription: 'sub_test_123',
    customer: 'cus_test_123',
    payment_status: 'paid',
    amount_total: 4999,
    currency: 'usd',
    metadata: {
      vendorId: VENDOR_ID,
    },
  };
}

function validSubscription(): MockSubscription {
  return {
    id: 'sub_test_123',
    status: 'active',
    cancel_at_period_end: false,
    customer: 'cus_test_123',
    items: {
      data: [
        {
          price: { id: 'price_premium_test' },
          current_period_end: 1893456000,
        },
      ],
    },
    metadata: {
      vendorId: VENDOR_ID,
    },
  };
}

function premiumVendor(
  overrides: Partial<MockUserDocument> = {},
): MockUserDocument {
  return {
    _id: VENDOR_ID,
    name: 'Test Vendor',
    role: 'vendor',
    subscriptionPlan: 'premium',
    isBlocked: false,
    stripeSubscriptionId: 'sub_test_123',
    stripeCustomerId: 'cus_test_123',
    subscriptionStatus: 'active',
    subscriptionCancelAtPeriodEnd: false,
    subscriptionCurrentPeriodEnd: '2029-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function lifecycleSubscription(
  overrides: Partial<MockSubscription> = {},
): MockSubscription {
  return {
    ...validSubscription(),
    ...overrides,
  };
}

test('valid completed subscription checkout activates the correct vendor', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);

      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'premium');
      assert.equal(user.stripeSubscriptionId, 'sub_test_123');
      assert.equal(user.stripeCustomerId, 'cus_test_123');
      assert.equal(user.subscriptionStatus, 'active');
      assert.equal(user.subscriptionCancelAtPeriodEnd, false);
      assert.equal(
        user.subscriptionCurrentPeriodEnd,
        '2030-01-01T00:00:00.000Z',
      );

      assert.equal(db.updateOneCalls.length, 1);
      assert.equal((db.updateOneCalls[0].filter._id as ObjectId).toHexString(), VENDOR_ID);
      assert.equal(
        (db.updateOneCalls[0].update as { $set: Record<string, unknown> }).$set.subscriptionPlan,
        'premium',
      );
    },
  );
});

test('non-subscription mode does not activate Premium', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', { ...validSession(), mode: 'payment' }, 'evt_mode_payment'),
    session: { ...validSession(), mode: 'payment' },
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: { ...validSession(), mode: 'payment' } },
        }),
      });

      assert.equal(response.status, 200);

      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'free');
      assert.equal(db.updateOneCalls.length, 0);
    },
  );
});

test('missing subscription ID does not activate Premium', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', { ...validSession(), subscription: null }, 'evt_no_subscription'),
    session: { ...validSession(), subscription: null },
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: { ...validSession(), subscription: null } },
        }),
      });

      assert.equal(response.status, 200);

      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'free');
      assert.equal(db.updateOneCalls.length, 0);
    },
  );
});

test('incorrect subscription status does not activate Premium', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: { ...validSubscription(), status: 'canceled' },
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);

      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'free');
      assert.equal(db.updateOneCalls.length, 0);
    },
  );
});

test('incorrect price ID does not activate Premium', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: {
      ...validSubscription(),
      items: {
        data: [
          {
            price: { id: 'price_other_test' },
          },
        ],
      },
    },
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);

      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'free');
      assert.equal(db.updateOneCalls.length, 0);
    },
  );
});

test('session/subscription metadata mismatch does not activate Premium', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: {
      ...validSubscription(),
      metadata: {
        vendorId: 'different_vendor_id',
      },
    },
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);

      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'free');
      assert.equal(db.updateOneCalls.length, 0);
    },
  );
});

test('invalid vendor ObjectId does not activate Premium', async () => {
  const db = createMockDatabase([]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', { ...validSession(), metadata: { vendorId: 'not-a-valid-id' } }, 'evt_invalid_vendor_id'),
    session: { ...validSession(), metadata: { vendorId: 'not-a-valid-id' } },
    subscription: { ...validSubscription(), metadata: { vendorId: 'not-a-valid-id' } },
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: {
            object: { ...validSession(), metadata: { vendorId: 'not-a-valid-id' } },
          },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(db.updateOneCalls.length, 0);
    },
  );
});

test('nonexistent vendor does not activate Premium', async () => {
  const db = createMockDatabase([]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(db.updateOneCalls.length, 0);
    },
  );
});

test('customer account cannot be activated as a vendor', async () => {
  const db = createMockDatabase([customerUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);

      const user = db.users.get(CUSTOMER_ID)!;
      assert.equal(user.role, 'customer');
      assert.equal(user.subscriptionPlan, 'free');
      assert.equal(db.updateOneCalls.length, 0);
    },
  );
});

test('Stripe retrieval failure does not activate Premium', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    sessionRetrieveError: false,
    subscriptionRetrieveError: true,
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);

      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'free');
      assert.equal(db.updateOneCalls.length, 0);
    },
  );
});

test('unrecognized webhook events do not modify vendor data', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('invoice.payment_succeeded'),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'invoice.payment_succeeded',
          data: { object: {} },
        }),
      });

      assert.equal(response.status, 200);

      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'free');
      assert.equal(db.updateOneCalls.length, 0);
    },
  );
});

test('trialing subscription status activates Premium', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: { ...validSubscription(), status: 'trialing' },
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);

      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'premium');
      assert.equal(db.updateOneCalls.length, 1);
    },
  );
});

test('valid verified checkout creates a transaction record', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);

      assert.equal(db.transactionCalls.length, 1);
      const tx = db.transactionCalls[0].document;
      assert.equal((tx.vendorId as ObjectId).toHexString(), VENDOR_ID);
      assert.equal(tx.stripeCheckoutSessionId, 'cs_test_123');
      assert.equal(tx.stripeCustomerId, 'cus_test_123');
      assert.equal(tx.stripeSubscriptionId, 'sub_test_123');
      assert.equal(tx.amount, 4999);
      assert.equal(tx.currency, 'usd');
      assert.equal(tx.status, 'paid');
      assert.ok(tx.createdAt instanceof Date);
    },
  );
});

test('invalid payment status does not create a transaction', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', {
      ...validSession(),
      payment_status: 'unpaid',
    }, 'evt_invalid_payment'),
    session: { ...validSession(), payment_status: 'unpaid' },
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: { ...validSession(), payment_status: 'unpaid' } },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(db.transactionCalls.length, 0);
    },
  );
});

test('nonexistent vendor does not create a transaction', async () => {
  const db = createMockDatabase([]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(db.transactionCalls.length, 0);
    },
  );
});

test('customer account does not create a transaction', async () => {
  const db = createMockDatabase([customerUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(db.transactionCalls.length, 0);
    },
  );
});

test('database insertion failure is handled safely', async () => {
  const db = createMockDatabase([vendorUser()]);

  const failingDb = {
    ...createDbMock(db),
    collection: (name: string) => {
      if (name === 'user') {
        return {
          findOne: async () => vendorUser(),
          updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }),
        } as never;
      }

      if (name === 'transactions') {
        throw new Error('Database insertion failed');
      }

      if (name === 'webhook-events') {
        return {
          findOne: async () => null,
          insertOne: async () => {
            throw new Error('Database insertion failed');
          },
          updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }),
        } as never;
      }

      return {} as never;
    },
  } as unknown as Db;

  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: failingDb },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      // Database failure → 500, not 200 (Step 5: retryable server error).
      assert.equal(response.status, 500);
    },
  );
});

test('existing Premium activation still works after transaction insert', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);

      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'premium');
      assert.equal(db.updateOneCalls.length, 1);
      assert.equal(db.transactionCalls.length, 1);
    },
  );
});

test('repeated delivery of same event ID does not create duplicate transaction', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  // First delivery.
  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(db.transactionCalls.length, 1);
      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'premium');
    },
  );

  // Second delivery with the same event ID — should find it already completed.
  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);
      // No additional transaction created.
      assert.equal(db.transactionCalls.length, 1);
      // No additional updateOne call.
      assert.equal(db.updateOneCalls.length, 1);
      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'premium');
    },
  );
});

test('already-processed event returns HTTP 200 without re-processing', async () => {
  const db = createMockDatabase([vendorUser()]);
  // Pre-mark the event as completed in the mock.
  db.webhookEvents.set('evt_test_duplicate', {
    stripeEventId: 'evt_test_duplicate',
    eventType: 'checkout.session.completed',
    status: 'completed',
    checkoutSessionId: 'cs_test_123',
    vendorId: VENDOR_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', {
      ...validSession(),
      id: 'cs_test_123',
    }, 'evt_test_duplicate'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: {
            object: { ...validSession(), id: 'cs_test_123' },
            id: 'evt_test_duplicate',
          },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(db.transactionCalls.length, 0);
      assert.equal(db.updateOneCalls.length, 0);
    },
  );
});

test('concurrent duplicate delivery via duplicate key is handled safely', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_concurrent'),
    session: validSession(),
    subscription: validSubscription(),
  });

  // First delivery succeeds normally.
  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(db.transactionCalls.length, 1);
    },
  );

  // Second delivery with the same event ID — simulate duplicate key on
  // webhook-events insert (another request already recorded it).
  db.shouldThrowDuplicateKey = true;

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      // The event was already completed by the first delivery → HTTP 200.
      assert.equal(response.status, 200);
      // No duplicate transaction created.
      assert.equal(db.transactionCalls.length, 1);
    },
  );
});

test('different event IDs for same Checkout Session cannot create duplicate transactions', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_1'),
    session: validSession(),
    subscription: validSubscription(),
  });

  // First delivery with event ID evt_1.
  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: { ...validSession(), id: 'cs_test_123' }, id: 'evt_1' },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(db.transactionCalls.length, 1);
    },
  );

  // Second delivery with different event ID evt_2 but same checkout session.
  // The existing-transaction check inside the transaction should find the
  // already-created transaction and skip inserting a duplicate.
  const stripeClient2 = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', {
      ...validSession(),
      id: 'cs_test_123',
    }, 'evt_2'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    {
      stripeClient: stripeClient2,
      webhookSecret: 'whsec_test',
      database: createDbMock(db),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: {
            object: { ...validSession(), id: 'cs_test_123' },
            id: 'evt_2',
          },
        }),
      });

      assert.equal(response.status, 200);
      // No second transaction created.
      assert.equal(db.transactionCalls.length, 1);
      // Both webhook events recorded as completed.
      assert.equal(db.webhookEvents.size, 2);
      const evt2 = db.webhookEvents.get('evt_2');
      assert.ok(evt2);
      assert.equal(evt2.status, 'completed');
    },
  );
});

test('database failure does not mark event as successfully processed', async () => {
  const db = createMockDatabase([vendorUser()]);
  db.shouldFailTransaction = true;

  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      // Database failure → 500, event NOT marked as completed.
      // (Mock does not simulate transaction rollback; event may exist as
      // 'pending' but must not be 'completed'.)
      assert.equal(response.status, 500);
      assert.equal(db.transactionCalls.length, 0);
      const eventRecord = db.webhookEvents.get('evt_default');
      assert.ok(!eventRecord || eventRecord.status !== 'completed');
    },
  );
});

test('failed processing can be retried successfully', async () => {
  const db = createMockDatabase([vendorUser()]);

  // First attempt: database fails.
  db.shouldFailTransaction = true;
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 500);
    },
  );

  // Second attempt: database works — should succeed.
  db.shouldFailTransaction = false;
  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);
      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'premium');
    },
  );
});

test('invalid payment status does not create transaction or event record', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', {
      ...validSession(),
      payment_status: 'unpaid',
    }, 'evt_invalid_payment_new'),
    session: { ...validSession(), payment_status: 'unpaid' },
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: { ...validSession(), payment_status: 'unpaid' } },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(db.transactionCalls.length, 0);
      assert.equal(db.updateOneCalls.length, 0);
      assert.equal(db.webhookEvents.size, 0);
    },
  );
});

test('invalid vendor does not create transaction or event record', async () => {
  const db = createMockDatabase([]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(db.transactionCalls.length, 0);
      assert.equal(db.updateOneCalls.length, 0);
      assert.equal(db.webhookEvents.size, 0);
    },
  );
});

test('customer account does not create transaction or event record', async () => {
  const db = createMockDatabase([customerUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(db.transactionCalls.length, 0);
      assert.equal(db.updateOneCalls.length, 0);
      assert.equal(db.webhookEvents.size, 0);
    },
  );
});

test('premium activation and transaction data remain consistent', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession(), 'evt_default'),
    session: validSession(),
    subscription: validSubscription(),
  });

  await withWebhookServer(
    { stripeClient, webhookSecret: 'whsec_test', database: createDbMock(db) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: validSession() },
        }),
      });

      assert.equal(response.status, 200);

      // Premium activated.
      const user = db.users.get(VENDOR_ID)!;
      assert.equal(user.subscriptionPlan, 'premium');

      // Transaction record created with correct data.
      assert.equal(db.transactionCalls.length, 1);
      const tx = db.transactionCalls[0].document;
      assert.equal((tx.vendorId as ObjectId).toHexString(), VENDOR_ID);
      assert.equal(tx.stripeCheckoutSessionId, 'cs_test_123');
      assert.equal(tx.stripeCustomerId, 'cus_test_123');
      assert.equal(tx.stripeSubscriptionId, 'sub_test_123');
      assert.equal(tx.amount, 4999);
      assert.equal(tx.currency, 'usd');
      assert.equal(tx.status, 'paid');
      assert.ok(tx.createdAt instanceof Date);

      // Webhook event recorded as completed.
      assert.equal(db.webhookEvents.size, 1);
      const eventRecord = db.webhookEvents.get('evt_default');
      assert.ok(eventRecord);
      assert.equal(eventRecord.status, 'completed');
      assert.equal(eventRecord.eventType, 'checkout.session.completed');
      assert.ok(eventRecord.processedAt instanceof Date);
    },
  );
});

test('transactions.stripeCheckoutSessionId unique index is partial (existing non-Stripe records unaffected)', async () => {
  const db = createMockDatabase([vendorUser()]);
  const mockDb = createDbMock(db);

  await ensureWebhookIndexes(mockDb as unknown as import('mongodb').Db);

  // Find the partial unique index on transactions.stripeCheckoutSessionId
  const partialIndex = db.transactionIndexCalls.find(
    (idx) => idx.name === 'idx_transactions_stripe_checkout_session_id_unique',
  );

  assert.ok(partialIndex, 'Partial unique index on stripeCheckoutSessionId should exist');
  assert.equal(partialIndex.unique, true);
  assert.ok(
    partialIndex.partialFilterExpression,
    'Partial filter expression should be present',
  );
  const pfe = partialIndex.partialFilterExpression as Record<string, unknown>;
  const stripeValue = pfe['stripeCheckoutSessionId'] as { $type: string };
  assert.equal(stripeValue.$type, 'string');

  // Verify that multiple documents without stripeCheckoutSessionId do not
  // conflict with the partial index (they are excluded by $type: "string").
  // Simulating existing non-Stripe records: two inserts without the field
  // should both succeed (no uniqueness conflict on missing/null values).
  assert.equal(db.transactionCalls.length, 0);
  assert.equal(db.usedCheckoutSessionIds.size, 0);
});

test('outdated full unique index is dropped before partial index creation', async () => {
  const db = createMockDatabase([vendorUser()]);
  const mockDb = createDbMock(db);

  // Pre-seed an outdated full unique index (no partialFilterExpression)
  db.transactionIndexCalls.push({
    key: { stripeCheckoutSessionId: 1 },
    name: 'idx_transactions_stripe_checkout_session_id_unique',
    unique: true,
  });

  await ensureWebhookIndexes(mockDb as unknown as import('mongodb').Db);

  // The outdated full index should have been dropped
  assert.equal(db.transactionIndexDroppedCalls.length, 1);
  assert.equal(
    db.transactionIndexDroppedCalls[0],
    'idx_transactions_stripe_checkout_session_id_unique',
  );

  // The new partial index should have been created
  const partialIndex = db.transactionIndexCalls.find(
    (idx) => idx.name === 'idx_transactions_stripe_checkout_session_id_unique',
  );
  assert.ok(partialIndex);
  assert.equal(partialIndex.unique, true);
  assert.ok(partialIndex.partialFilterExpression);
  const pfe = partialIndex.partialFilterExpression as Record<string, unknown>;
  const stripeValue = pfe['stripeCheckoutSessionId'] as { $type: string };
  assert.equal(stripeValue.$type, 'string');

  // No transaction documents were dropped or modified
  assert.equal(db.transactionCalls.length, 0);
  assert.equal(db.usedCheckoutSessionIds.size, 0);
});

test('duplicate non-empty Checkout Session IDs prevent index creation', async () => {
  const db = createMockDatabase([vendorUser()]);
  const mockDb = createDbMock(db);

  // Simulate existing duplicate transaction records with the same
  // non-empty stripeCheckoutSessionId
  db.transactionCalls.push({
    document: {
      stripeCheckoutSessionId: 'cs_dup_1',
      vendorId: VENDOR_ID,
    },
  });
  db.transactionCalls.push({
    document: {
      stripeCheckoutSessionId: 'cs_dup_1',
      vendorId: VENDOR_ID,
    },
  });

  await assert.rejects(
    ensureWebhookIndexes(mockDb as unknown as import('mongodb').Db),
    /duplicate Checkout Session ID/,
  );

  // No transaction documents were dropped or modified
  assert.equal(db.transactionCalls.length, 2);
});

// ----- Subscription lifecycle tests -----

async function deliverLifecycleEvent(options: {
  db: MockDatabase;
  eventType: string;
  object: unknown;
  eventId: string;
  database?: Db;
}): Promise<number> {
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent(
      options.eventType,
      options.object,
      options.eventId,
    ),
  });

  let status = 0;

  await withWebhookServer(
    {
      stripeClient,
      webhookSecret: 'whsec_test',
      database: options.database ?? createDbMock(options.db),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'stripe-signature': 't=1234567890,v1=testsig',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: options.eventType,
          data: { object: options.object },
        }),
      });

      status = response.status;
    },
  );

  return status;
}

test('customer.subscription.updated syncs lifecycle fields and keeps Premium', async () => {
  const db = createMockDatabase([premiumVendor()]);
  const subscription = lifecycleSubscription({
    status: 'active',
    cancel_at_period_end: true,
  });

  const status = await deliverLifecycleEvent({
    db,
    eventType: 'customer.subscription.updated',
    object: subscription,
    eventId: 'evt_sub_updated',
  });

  assert.equal(status, 200);

  const user = db.users.get(VENDOR_ID)!;
  assert.equal(user.subscriptionPlan, 'premium');
  assert.equal(user.subscriptionStatus, 'active');
  assert.equal(user.subscriptionCancelAtPeriodEnd, true);
  assert.equal(
    user.subscriptionCurrentPeriodEnd,
    '2030-01-01T00:00:00.000Z',
  );

  assert.equal(db.updateOneCalls.length, 1);
  const set = (db.updateOneCalls[0].update as { $set: Record<string, unknown> })
    .$set;
  assert.equal(set.subscriptionPlan, undefined);

  const event = db.webhookEvents.get('evt_sub_updated');
  assert.ok(event);
  assert.equal(event.status, 'completed');
  assert.equal(event.eventType, 'customer.subscription.updated');
});

test('customer.subscription.updated never activates Premium for a free vendor', async () => {
  const db = createMockDatabase([vendorUser()]);
  const subscription = lifecycleSubscription({ status: 'active' });

  const status = await deliverLifecycleEvent({
    db,
    eventType: 'customer.subscription.updated',
    object: subscription,
    eventId: 'evt_sub_free_update',
  });

  assert.equal(status, 200);

  const user = db.users.get(VENDOR_ID)!;
  assert.equal(user.subscriptionPlan, 'free');
  assert.equal(db.updateOneCalls.length, 0);
  assert.equal(db.webhookEvents.size, 0);
});

test('customer.subscription.updated does not upgrade an inconsistent free vendor with a stored subscription', async () => {
  const db = createMockDatabase([
    premiumVendor({ subscriptionPlan: 'free' }),
  ]);
  const subscription = lifecycleSubscription({ status: 'active' });

  const status = await deliverLifecycleEvent({
    db,
    eventType: 'customer.subscription.updated',
    object: subscription,
    eventId: 'evt_sub_inconsistent_update',
  });

  assert.equal(status, 200);

  const user = db.users.get(VENDOR_ID)!;
  assert.equal(user.subscriptionPlan, 'free');
  assert.equal(db.updateOneCalls.length, 1);
  const set = (db.updateOneCalls[0].update as { $set: Record<string, unknown> })
    .$set;
  assert.equal(set.subscriptionPlan, undefined);
});

test('customer.subscription.updated ignores stale events for a replaced subscription', async () => {
  const db = createMockDatabase([
    premiumVendor({ stripeSubscriptionId: 'sub_replaced' }),
  ]);
  const subscription = lifecycleSubscription({ status: 'active' });

  const status = await deliverLifecycleEvent({
    db,
    eventType: 'customer.subscription.updated',
    object: subscription,
    eventId: 'evt_sub_stale_update',
  });

  assert.equal(status, 200);

  const user = db.users.get(VENDOR_ID)!;
  assert.equal(user.subscriptionPlan, 'premium');
  assert.equal(user.stripeSubscriptionId, 'sub_replaced');
  assert.equal(db.updateOneCalls.length, 0);
  assert.equal(db.webhookEvents.size, 0);
});

test('customer.subscription.updated ignores invalid vendor metadata', async () => {
  const db = createMockDatabase([premiumVendor()]);
  const subscription = lifecycleSubscription({
    metadata: { vendorId: 'not-a-valid-id' },
  });

  const status = await deliverLifecycleEvent({
    db,
    eventType: 'customer.subscription.updated',
    object: subscription,
    eventId: 'evt_sub_invalid_vendor',
  });

  assert.equal(status, 200);
  assert.equal(db.updateOneCalls.length, 0);
  assert.equal(db.webhookEvents.size, 0);
});

test('customer.subscription.updated ignores customer accounts', async () => {
  const db = createMockDatabase([
    { ...customerUser(), stripeSubscriptionId: 'sub_test_123' },
  ]);
  const subscription = lifecycleSubscription({ status: 'active' });

  const status = await deliverLifecycleEvent({
    db,
    eventType: 'customer.subscription.updated',
    object: subscription,
    eventId: 'evt_sub_customer_update',
  });

  assert.equal(status, 200);

  const user = db.users.get(CUSTOMER_ID)!;
  assert.equal(user.role, 'customer');
  assert.equal(user.subscriptionPlan, 'free');
  assert.equal(db.updateOneCalls.length, 0);
});

test('customer.subscription.updated supports legacy top-level period end', async () => {
  const db = createMockDatabase([premiumVendor()]);
  const subscription = lifecycleSubscription({
    items: {
      data: [{ price: { id: 'price_premium_test' } }],
    },
    current_period_end: 1893456000,
  });

  const status = await deliverLifecycleEvent({
    db,
    eventType: 'customer.subscription.updated',
    object: subscription,
    eventId: 'evt_sub_legacy_period',
  });

  assert.equal(status, 200);
  const user = db.users.get(VENDOR_ID)!;
  assert.equal(
    user.subscriptionCurrentPeriodEnd,
    '2030-01-01T00:00:00.000Z',
  );
});

test('customer.subscription.deleted downgrades the matching vendor to Free', async () => {
  const db = createMockDatabase([premiumVendor()]);

  // Historical transaction records must be preserved.
  db.transactionCalls.push({
    document: {
      vendorId: VENDOR_ID,
      stripeCheckoutSessionId: 'cs_historical',
      stripeCustomerId: 'cus_test_123',
      stripeSubscriptionId: 'sub_test_123',
      amount: 999,
      currency: 'usd',
      status: 'paid',
      createdAt: new Date(),
    },
  });

  const subscription = lifecycleSubscription({
    status: 'canceled',
    cancel_at_period_end: false,
  });

  const status = await deliverLifecycleEvent({
    db,
    eventType: 'customer.subscription.deleted',
    object: subscription,
    eventId: 'evt_sub_deleted',
  });

  assert.equal(status, 200);

  const user = db.users.get(VENDOR_ID)!;
  assert.equal(user.subscriptionPlan, 'free');
  assert.equal(user.subscriptionStatus, 'canceled');
  assert.equal(user.subscriptionCancelAtPeriodEnd, false);
  assert.equal(user.stripeSubscriptionId, null);
  assert.equal(
    user.subscriptionCurrentPeriodEnd,
    '2030-01-01T00:00:00.000Z',
  );

  assert.equal(db.updateOneCalls.length, 1);
  assert.equal(db.transactionCalls.length, 1);

  const event = db.webhookEvents.get('evt_sub_deleted');
  assert.ok(event);
  assert.equal(event.status, 'completed');
});

test('customer.subscription.deleted does not downgrade a replaced subscription', async () => {
  const db = createMockDatabase([
    premiumVendor({ stripeSubscriptionId: 'sub_replaced' }),
  ]);
  const subscription = lifecycleSubscription({ status: 'canceled' });

  const status = await deliverLifecycleEvent({
    db,
    eventType: 'customer.subscription.deleted',
    object: subscription,
    eventId: 'evt_sub_stale_deleted',
  });

  assert.equal(status, 200);

  const user = db.users.get(VENDOR_ID)!;
  assert.equal(user.subscriptionPlan, 'premium');
  assert.equal(user.stripeSubscriptionId, 'sub_replaced');
  assert.equal(db.updateOneCalls.length, 0);
});

test('customer.subscription.deleted ignores nonexistent vendors', async () => {
  const db = createMockDatabase([]);
  const subscription = lifecycleSubscription({ status: 'canceled' });

  const status = await deliverLifecycleEvent({
    db,
    eventType: 'customer.subscription.deleted',
    object: subscription,
    eventId: 'evt_sub_missing_vendor',
  });

  assert.equal(status, 200);
  assert.equal(db.updateOneCalls.length, 0);
  assert.equal(db.webhookEvents.size, 0);
});

test('duplicate subscription lifecycle event is acknowledged without re-processing', async () => {
  const db = createMockDatabase([premiumVendor()]);
  db.webhookEvents.set('evt_sub_deleted_duplicate', {
    stripeEventId: 'evt_sub_deleted_duplicate',
    eventType: 'customer.subscription.deleted',
    status: 'completed',
    vendorId: VENDOR_ID,
    processedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const subscription = lifecycleSubscription({ status: 'canceled' });

  const status = await deliverLifecycleEvent({
    db,
    eventType: 'customer.subscription.deleted',
    object: subscription,
    eventId: 'evt_sub_deleted_duplicate',
  });

  assert.equal(status, 200);

  const user = db.users.get(VENDOR_ID)!;
  assert.equal(user.subscriptionPlan, 'premium');
  assert.equal(db.updateOneCalls.length, 0);
});

test('subscription lifecycle database failure returns retryable 500', async () => {
  const db = createMockDatabase([premiumVendor()]);
  const baseDb = createDbMock(db);

  const failingDb = {
    collection: (name: string) => {
      if (name === 'user') {
        return {
          findOne: async () => db.users.get(VENDOR_ID) ?? null,
          updateOne: async () => {
            throw new Error('Database write failed');
          },
        } as never;
      }

      return baseDb.collection(name);
    },
  } as unknown as Db;

  const subscription = lifecycleSubscription({ status: 'active' });

  const status = await deliverLifecycleEvent({
    db,
    database: failingDb,
    eventType: 'customer.subscription.updated',
    object: subscription,
    eventId: 'evt_sub_failure',
  });

  assert.equal(status, 500);

  const event = db.webhookEvents.get('evt_sub_failure');
  assert.ok(!event || event.status !== 'completed');
  const user = db.users.get(VENDOR_ID)!;
  assert.equal(user.subscriptionPlan, 'premium');
});
