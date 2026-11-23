import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { ObjectId, type Db } from 'mongodb';
import type { StripeClient } from '../src/services/stripe.service.js';
import { createStripeWebhookRouter } from '../src/routes/webhook.routes.js';

type MockConstructEvent = (
  payload: string | Buffer,
  sig: string,
  secret: string,
) => { type: string; data: { object: unknown } };

const mockConstructEvent = (
  eventType: string,
  sessionObject?: unknown,
): MockConstructEvent => {
  return (_payload, _sig, _secret) => {
    return {
      type: eventType,
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
  items: {
    data: Array<{
      price: { id: string };
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
          insertOne: async (document: unknown) => {
            db.transactionCalls.push({ document: document as Partial<MockTransactionDocument> });
            return { acknowledged: true, insertedId: new ObjectId() };
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
  },
  action: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const db =
    options.database ??
    createDbMock(createMockDatabase([]));

  const app = express();
  app.use(
    '/api/webhooks',
    createStripeWebhookRouter(db, { stripeClient: options.stripeClient }),
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
    items: {
      data: [
        {
          price: { id: 'price_premium_test' },
        },
      ],
    },
    metadata: {
      vendorId: VENDOR_ID,
    },
  };
}

test('valid completed subscription checkout activates the correct vendor', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession()),
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
    constructEvent: mockConstructEvent('checkout.session.completed', { ...validSession(), mode: 'payment' }),
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
    constructEvent: mockConstructEvent('checkout.session.completed', { ...validSession(), subscription: null }),
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
    constructEvent: mockConstructEvent('checkout.session.completed', validSession()),
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
    constructEvent: mockConstructEvent('checkout.session.completed', validSession()),
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
    constructEvent: mockConstructEvent('checkout.session.completed', validSession()),
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
    constructEvent: mockConstructEvent('checkout.session.completed', { ...validSession(), metadata: { vendorId: 'not-a-valid-id' } }),
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
    constructEvent: mockConstructEvent('checkout.session.completed', validSession()),
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
    constructEvent: mockConstructEvent('checkout.session.completed', validSession()),
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
    constructEvent: mockConstructEvent('checkout.session.completed', validSession()),
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
    constructEvent: mockConstructEvent('checkout.session.completed', validSession()),
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
    constructEvent: mockConstructEvent('checkout.session.completed', validSession()),
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
    }),
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
    constructEvent: mockConstructEvent('checkout.session.completed', validSession()),
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
    constructEvent: mockConstructEvent('checkout.session.completed', validSession()),
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

      return {} as never;
    },
  } as unknown as Db;

  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession()),
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

      assert.equal(response.status, 200);
    },
  );
});

test('existing Premium activation still works after transaction insert', async () => {
  const db = createMockDatabase([vendorUser()]);
  const stripeClient = createMockStripeClient({
    constructEvent: mockConstructEvent('checkout.session.completed', validSession()),
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
