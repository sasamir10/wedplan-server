import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId, type Db } from 'mongodb';
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { AuthenticatedRole } from '../src/middleware/authenticate.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { createSubscriptionRouter } from '../src/routes/subscription.routes.js';
import { createSubscriptionCheckoutSession, scheduleVendorSubscriptionCancellation } from '../src/services/subscription.service.js';
import { AppError } from '../src/utils/app-error.js';

type MemoryUser = {
  _id: ObjectId;
  name: string;
  role?: unknown;
  subscriptionPlan?: unknown;
  isBlocked?: unknown;
  stripeSubscriptionId?: unknown;
  stripeCustomerId?: unknown;
  subscriptionStatus?: unknown;
  subscriptionCancelAtPeriodEnd?: unknown;
  subscriptionCurrentPeriodEnd?: unknown;
  updatedAt?: unknown;
};

function createDatabase(users: MemoryUser[]): Db {
  const collection = {
    findOne: async (filter: Record<string, unknown>) => {
      const user = users.find(
        (u) => u._id instanceof ObjectId && filter._id instanceof ObjectId && u._id.equals(filter._id),
      );
      return user ?? null;
    },
    updateOne: async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => {
      const user = users.find(
        (u) => u._id instanceof ObjectId && filter._id instanceof ObjectId && u._id.equals(filter._id),
      );

      if (!user) {
        return { matchedCount: 0, modifiedCount: 0 };
      }

      if (update.$set && typeof update.$set === 'object') {
        Object.assign(user, update.$set as Record<string, unknown>);
      }

      return { matchedCount: 1, modifiedCount: 1 };
    },
  } as unknown as ReturnType<Db['collection']>;

  return { collection: () => collection } as unknown as Db;
}

const VENDOR_ID = new ObjectId().toHexString();
const CUSTOMER_ID = new ObjectId().toHexString();
const BLOCKED_VENDOR_ID = new ObjectId().toHexString();
const PREMIUM_VENDOR_ID = new ObjectId().toHexString();
const NON_OBJECT_ID = 'not-a-valid-id';

function userRecord(idHex: string, overrides: Record<string, unknown> = {}): MemoryUser {
  return {
    _id: new ObjectId(idHex),
    name: 'Test User',
    ...overrides,
  };
}

const mockStripeSession = {
  id: 'cs_test_1234567890',
  url: 'https://checkout.stripe.com/sessions/cs_test_1234567890',
};

let lastCreateArgs: unknown;

const mockStripeClient = {
  checkout: {
    sessions: {
      create: async (args: unknown) => {
        lastCreateArgs = args;
        return mockStripeSession;
      },
    },
  },
} as unknown as Parameters<typeof createSubscriptionCheckoutSession>[2];

const failingStripeClient = {
  checkout: {
    sessions: {
      create: async () => {
        throw new Error('Stripe API error');
      },
    },
  },
} as unknown as Parameters<typeof createSubscriptionCheckoutSession>[2];

async function withSubscriptionServer<T>(
  database: Db,
  action: (baseUrl: string) => Promise<T>,
  options: {
    stripeClient?: Parameters<typeof createSubscriptionCheckoutSession>[2];
  } = {},
): Promise<T> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/api/vendor',
    createSubscriptionRouter(database, {
      authenticate: testAuthenticate,
      stripeClient: options.stripeClient,
    }),
  );
  app.use(errorHandler);
  const server: Server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port.');
  }

  try {
    return await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const testAuthenticate: RequestHandler = (request, _response, next) => {
  const role = request.get('x-test-role');
  const userId = request.get('x-test-user-id');

  if (!role || !userId) {
    next(new AppError('Authentication required.', 401, true, 'AUTHENTICATION_REQUIRED'));
    return;
  }

  request.authenticatedUser = {
    id: userId,
    email: 'test@example.com',
    role: role as AuthenticatedRole,
    isBlocked: false,
    issuedAt: 0,
    expiresAt: 0,
  };
  next();
};

function authHeaders(role: AuthenticatedRole, userId: string) {
  return {
    'x-test-role': role,
    'x-test-user-id': userId,
  };
}

// ----- Service-level tests -----

test('createSubscriptionCheckoutSession creates a checkout session for a valid vendor', async () => {
  const database = createDatabase([userRecord(VENDOR_ID, { role: 'vendor', subscriptionPlan: 'free', isBlocked: false })]);
  const result = await createSubscriptionCheckoutSession(database, VENDOR_ID, mockStripeClient);

  assert.equal(result.checkoutUrl, 'https://checkout.stripe.com/sessions/cs_test_1234567890');
  assert.equal(result.sessionId, 'cs_test_1234567890');
  assert.equal((lastCreateArgs as { success_url?: string; cancel_url?: string })?.success_url, 'http://localhost:3000/vendor/subscription/success?session_id={CHECKOUT_SESSION_ID}');
  assert.equal((lastCreateArgs as { success_url?: string; cancel_url?: string })?.cancel_url, 'http://localhost:3000/vendor/subscription/cancel');
});

test('createSubscriptionCheckoutSession rejects a non-existent vendor', async () => {
  const database = createDatabase([]);
  await assert.rejects(
    createSubscriptionCheckoutSession(database, new ObjectId().toHexString(), mockStripeClient),
    (error: AppError) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'VENDOR_NOT_FOUND');
      return true;
    },
  );
});

test('createSubscriptionCheckoutSession rejects a non-vendor role', async () => {
  const database = createDatabase([userRecord(CUSTOMER_ID, { role: 'customer', subscriptionPlan: 'free', isBlocked: false })]);
  await assert.rejects(
    createSubscriptionCheckoutSession(database, CUSTOMER_ID, mockStripeClient),
    (error: AppError) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'ROLE_FORBIDDEN');
      return true;
    },
  );
});

test('createSubscriptionCheckoutSession rejects a blocked vendor', async () => {
  const database = createDatabase([userRecord(BLOCKED_VENDOR_ID, { role: 'vendor', subscriptionPlan: 'free', isBlocked: true })]);
  await assert.rejects(
    createSubscriptionCheckoutSession(database, BLOCKED_VENDOR_ID, mockStripeClient),
    (error: AppError) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'ACCOUNT_BLOCKED');
      return true;
    },
  );
});

test('createSubscriptionCheckoutSession rejects an already-premium vendor', async () => {
  const database = createDatabase([userRecord(PREMIUM_VENDOR_ID, { role: 'vendor', subscriptionPlan: 'premium', isBlocked: false })]);
  await assert.rejects(
    createSubscriptionCheckoutSession(database, PREMIUM_VENDOR_ID, mockStripeClient),
    (error: AppError) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'ALREADY_PREMIUM');
      return true;
    },
  );
});

test('createSubscriptionCheckoutSession handles Stripe API failure', async () => {
  const database = createDatabase([userRecord(VENDOR_ID, { role: 'vendor', subscriptionPlan: 'free', isBlocked: false })]);
  await assert.rejects(
    createSubscriptionCheckoutSession(database, VENDOR_ID, failingStripeClient),
    (error: AppError) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, 'STRIPE_CHECKOUT_FAILED');
      return true;
    },
  );
});

test('createSubscriptionCheckoutSession rejects invalid vendor ID', async () => {
  const database = createDatabase([]);
  await assert.rejects(
    createSubscriptionCheckoutSession(database, NON_OBJECT_ID, mockStripeClient),
    (error: AppError) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'VENDOR_NOT_FOUND');
      return true;
    },
  );
});

// ----- Route-level tests -----

test('POST /api/vendor/subscription/checkout rejects unauthenticated request', async () => {
  const database = createDatabase([]);

  await withSubscriptionServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/vendor/subscription/checkout`, {
      method: 'POST',
    });

    assert.equal(response.status, 401);
  });
});

test('POST /api/vendor/subscription/checkout rejects non-vendor role', async () => {
  const database = createDatabase([userRecord(CUSTOMER_ID, { role: 'customer', subscriptionPlan: 'free', isBlocked: false })]);

  await withSubscriptionServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/vendor/subscription/checkout`, {
      method: 'POST',
      headers: authHeaders('customer', CUSTOMER_ID),
    });

    assert.equal(response.status, 403);
  });
});

test('POST /api/vendor/subscription/checkout rejects blocked vendor', async () => {
  const database = createDatabase([userRecord(BLOCKED_VENDOR_ID, { role: 'vendor', subscriptionPlan: 'free', isBlocked: true })]);

  await withSubscriptionServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/vendor/subscription/checkout`, {
      method: 'POST',
      headers: authHeaders('vendor', BLOCKED_VENDOR_ID),
    });

    assert.equal(response.status, 403);
  });
});

test('POST /api/vendor/subscription/checkout rejects already-premium vendor', async () => {
  const database = createDatabase([userRecord(PREMIUM_VENDOR_ID, { role: 'vendor', subscriptionPlan: 'premium', isBlocked: false })]);

  await withSubscriptionServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/vendor/subscription/checkout`, {
      method: 'POST',
      headers: authHeaders('vendor', PREMIUM_VENDOR_ID),
    });

    assert.equal(response.status, 409);
  });
});

// ----- Subscription cancellation tests -----

const CANCEL_VENDOR_ID = new ObjectId().toHexString();
const PERIOD_END_SECONDS = 1893456000;
const PERIOD_END_ISO = new Date(PERIOD_END_SECONDS * 1000).toISOString();

function cancelVendor(overrides: Record<string, unknown> = {}): MemoryUser {
  return userRecord(CANCEL_VENDOR_ID, {
    role: 'vendor',
    subscriptionPlan: 'premium',
    isBlocked: false,
    stripeSubscriptionId: 'sub_test_cancel',
    stripeCustomerId: 'cus_test_cancel',
    subscriptionStatus: 'active',
    subscriptionCancelAtPeriodEnd: false,
    ...overrides,
  });
}

interface CancellationStripeOptions {
  vendorId?: string;
  subscription?: Record<string, unknown>;
  retrieveError?: boolean;
  updateError?: boolean;
}

let lastCancelUpdateArgs: unknown;
let cancelUpdateCalls = 0;
let lastRetrieveId: string | null = null;

function createCancellationStripeClient(
  options: CancellationStripeOptions = {},
) {
  const vendorId = options.vendorId ?? CANCEL_VENDOR_ID;
  const baseSubscription = {
    id: 'sub_test_cancel',
    status: 'active',
    cancel_at_period_end: false,
    customer: 'cus_test_cancel',
    metadata: { vendorId },
    items: {
      data: [
        {
          price: { id: 'price_premium_test' },
          current_period_end: PERIOD_END_SECONDS,
        },
      ],
    },
    ...options.subscription,
  };

  return {
    subscriptions: {
      retrieve: async (subscriptionId: string) => {
        lastRetrieveId = subscriptionId;
        if (options.retrieveError) {
          throw new Error('Stripe retrieval failed');
        }
        return baseSubscription;
      },
      update: async (_subscriptionId: string, args: unknown) => {
        if (options.updateError) {
          throw new Error('Stripe update failed');
        }
        lastCancelUpdateArgs = args;
        cancelUpdateCalls += 1;
        return { ...baseSubscription, cancel_at_period_end: true };
      },
    },
  } as unknown as Parameters<typeof scheduleVendorSubscriptionCancellation>[2];
}

test('scheduleVendorSubscriptionCancellation schedules cancellation at period end', async () => {
  cancelUpdateCalls = 0;
  lastCancelUpdateArgs = undefined;
  const users = [cancelVendor()];
  const database = createDatabase(users);

  const result = await scheduleVendorSubscriptionCancellation(
    database,
    CANCEL_VENDOR_ID,
    createCancellationStripeClient(),
  );

  assert.equal(result.cancelled, true);
  assert.equal(result.cancelAtPeriodEnd, true);
  assert.equal(result.currentPeriodEnd, PERIOD_END_ISO);
  assert.equal(result.subscriptionStatus, 'active');
  assert.deepEqual(lastCancelUpdateArgs, { cancel_at_period_end: true });
  assert.equal(cancelUpdateCalls, 1);

  assert.equal(users[0].subscriptionPlan, 'premium');
  assert.equal(users[0].subscriptionCancelAtPeriodEnd, true);
  assert.equal(users[0].subscriptionCurrentPeriodEnd, PERIOD_END_ISO);
  assert.equal(users[0].subscriptionStatus, 'active');
  assert.ok(users[0].updatedAt instanceof Date);
});

test('scheduleVendorSubscriptionCancellation repairs an already scheduled cancellation without updating Stripe', async () => {
  cancelUpdateCalls = 0;
  const users = [cancelVendor({ subscriptionCancelAtPeriodEnd: true })];
  const database = createDatabase(users);

  const result = await scheduleVendorSubscriptionCancellation(
    database,
    CANCEL_VENDOR_ID,
    createCancellationStripeClient({
      subscription: { cancel_at_period_end: true },
    }),
  );

  assert.equal(result.cancelled, false);
  assert.equal(result.cancelAtPeriodEnd, true);
  assert.equal(result.currentPeriodEnd, PERIOD_END_ISO);
  assert.equal(cancelUpdateCalls, 0);
  assert.equal(users[0].subscriptionCancelAtPeriodEnd, true);
  assert.equal(users[0].subscriptionCurrentPeriodEnd, PERIOD_END_ISO);
});

test('scheduleVendorSubscriptionCancellation rejects a vendor without a stored subscription', async () => {
  const database = createDatabase([
    cancelVendor({ stripeSubscriptionId: undefined }),
  ]);

  await assert.rejects(
    scheduleVendorSubscriptionCancellation(
      database,
      CANCEL_VENDOR_ID,
      createCancellationStripeClient(),
    ),
    { statusCode: 404, code: 'NO_SUBSCRIPTION' },
  );
});

test('scheduleVendorSubscriptionCancellation rejects a subscription owned by another vendor', async () => {
  const database = createDatabase([cancelVendor()]);

  await assert.rejects(
    scheduleVendorSubscriptionCancellation(
      database,
      CANCEL_VENDOR_ID,
      createCancellationStripeClient({
        vendorId: new ObjectId().toHexString(),
      }),
    ),
    { statusCode: 403, code: 'SUBSCRIPTION_MISMATCH' },
  );
});

test('scheduleVendorSubscriptionCancellation rejects an ineligible subscription status', async () => {
  const database = createDatabase([cancelVendor()]);

  await assert.rejects(
    scheduleVendorSubscriptionCancellation(
      database,
      CANCEL_VENDOR_ID,
      createCancellationStripeClient({
        subscription: { status: 'canceled' },
      }),
    ),
    { statusCode: 409, code: 'SUBSCRIPTION_INELIGIBLE' },
  );
});

test('scheduleVendorSubscriptionCancellation maps Stripe retrieval failures safely', async () => {
  const database = createDatabase([cancelVendor()]);

  await assert.rejects(
    scheduleVendorSubscriptionCancellation(
      database,
      CANCEL_VENDOR_ID,
      createCancellationStripeClient({ retrieveError: true }),
    ),
    { statusCode: 502, code: 'STRIPE_RETRIEVE_FAILED' },
  );
});

test('scheduleVendorSubscriptionCancellation maps Stripe update failures safely', async () => {
  const database = createDatabase([cancelVendor()]);

  await assert.rejects(
    scheduleVendorSubscriptionCancellation(
      database,
      CANCEL_VENDOR_ID,
      createCancellationStripeClient({ updateError: true }),
    ),
    { statusCode: 502, code: 'STRIPE_CANCEL_FAILED' },
  );
});

test('scheduleVendorSubscriptionCancellation rejects non-vendor and blocked accounts', async () => {
  const customerDatabase = createDatabase([
    cancelVendor({ role: 'customer' }),
  ]);
  await assert.rejects(
    scheduleVendorSubscriptionCancellation(
      customerDatabase,
      CANCEL_VENDOR_ID,
      createCancellationStripeClient(),
    ),
    { statusCode: 403, code: 'ROLE_FORBIDDEN' },
  );

  const blockedDatabase = createDatabase([
    cancelVendor({ isBlocked: true }),
  ]);
  await assert.rejects(
    scheduleVendorSubscriptionCancellation(
      blockedDatabase,
      CANCEL_VENDOR_ID,
      createCancellationStripeClient(),
    ),
    { statusCode: 403, code: 'ACCOUNT_BLOCKED' },
  );
});

test('scheduleVendorSubscriptionCancellation rejects an invalid vendor ID', async () => {
  const database = createDatabase([cancelVendor()]);

  await assert.rejects(
    scheduleVendorSubscriptionCancellation(
      database,
      NON_OBJECT_ID,
      createCancellationStripeClient(),
    ),
    { statusCode: 403, code: 'VENDOR_NOT_FOUND' },
  );
});

test('POST /api/vendor/subscription/cancel rejects unauthenticated request', async () => {
  const database = createDatabase([cancelVendor()]);

  await withSubscriptionServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/vendor/subscription/cancel`, {
      method: 'POST',
    });

    assert.equal(response.status, 401);
  });
});

test('POST /api/vendor/subscription/cancel rejects non-vendor role', async () => {
  const database = createDatabase([
    cancelVendor({ role: 'customer' }),
  ]);

  await withSubscriptionServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/vendor/subscription/cancel`, {
      method: 'POST',
      headers: authHeaders('customer', CANCEL_VENDOR_ID),
    });

    assert.equal(response.status, 403);
  });
});

test('POST /api/vendor/subscription/cancel ignores client-supplied subscription identity', async () => {
  lastRetrieveId = null;
  const users = [cancelVendor()];
  const database = createDatabase(users);

  await withSubscriptionServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/vendor/subscription/cancel`, {
      method: 'POST',
      headers: {
        ...authHeaders('vendor', CANCEL_VENDOR_ID),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        vendorId: new ObjectId().toHexString(),
        stripeSubscriptionId: 'sub_attacker_supplied',
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.success, true);
    assert.equal(body.cancelled, true);
    assert.equal(body.cancelAtPeriodEnd, true);
    assert.equal(body.currentPeriodEnd, PERIOD_END_ISO);
    assert.equal(lastRetrieveId, 'sub_test_cancel');
    assert.equal(users[0].subscriptionCancelAtPeriodEnd, true);
  }, { stripeClient: createCancellationStripeClient() });
});

test('POST /api/vendor/subscription/cancel returns already-scheduled state without duplicate Stripe update', async () => {
  cancelUpdateCalls = 0;
  const database = createDatabase([
    cancelVendor({ subscriptionCancelAtPeriodEnd: true }),
  ]);

  await withSubscriptionServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/vendor/subscription/cancel`, {
      method: 'POST',
      headers: authHeaders('vendor', CANCEL_VENDOR_ID),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.cancelled, false);
    assert.equal(body.cancelAtPeriodEnd, true);
    assert.equal(cancelUpdateCalls, 0);
  }, {
    stripeClient: createCancellationStripeClient({
      subscription: { cancel_at_period_end: true },
    }),
  });
});
