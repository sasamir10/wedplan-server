import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId, type Db } from 'mongodb';
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import type { AuthenticatedRole } from '../src/middleware/authenticate.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { createSubscriptionRouter } from '../src/routes/subscription.routes.js';
import { createSubscriptionCheckoutSession } from '../src/services/subscription.service.js';
import { AppError } from '../src/utils/app-error.js';

type MemoryUser = {
  _id: ObjectId;
  name: string;
  role?: unknown;
  subscriptionPlan?: unknown;
  isBlocked?: unknown;
};

function createDatabase(users: MemoryUser[]): Db {
  const collection = {
    findOne: async (filter: Record<string, unknown>) => {
      const user = users.find(
        (u) => u._id instanceof ObjectId && filter._id instanceof ObjectId && u._id.equals(filter._id),
      );
      return user ?? null;
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
): Promise<T> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/vendor', createSubscriptionRouter(database, { authenticate: testAuthenticate }));
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
