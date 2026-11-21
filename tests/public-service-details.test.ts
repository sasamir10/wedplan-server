import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { test } from 'node:test';
import { ObjectId, type Db } from 'mongodb';
import type { AuthenticatedRole } from '../src/middleware/authenticate.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { createPublicServicesRouter } from '../src/routes/public-services.routes.js';
import type { ServiceDocument } from '../src/services/service.service.js';
import { AppError } from '../src/utils/app-error.js';

type MemoryRecord = Record<string, unknown> & { _id: ObjectId };

// Better Auth stores user._id as an ObjectId while services.vendorId is a hex string.
const vendorObjectId = new ObjectId();
const vendorId = vendorObjectId.toHexString();
const otherVendorId = new ObjectId().toHexString();
const customerId = new ObjectId().toHexString();
const adminId = new ObjectId().toHexString();

function service(overrides: Partial<ServiceDocument> = {}): ServiceDocument {
  const createdAt = new Date('2026-11-21T00:00:00.000Z');

  return {
    _id: new ObjectId(),
    vendorId,
    serviceName: 'Wedding Photography',
    category: 'Photography & Videography',
    description: 'Full-day wedding photography with an edited gallery.',
    price: 1200,
    location: 'Dhaka',
    images: [
      'https://images.example.com/wedding-1.jpg',
      'https://images.example.com/wedding-2.jpg',
    ],
    status: 'Approved',
    availability: true,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function matches(document: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = document[key];

    if (expected instanceof ObjectId) {
      return actual instanceof ObjectId && actual.equals(expected);
    }

    if (typeof expected === 'object' && expected !== null) {
      const operators = expected as Record<string, unknown>;

      if ('$in' in operators && Array.isArray(operators.$in)) {
        return operators.$in.some((candidate) =>
          candidate instanceof ObjectId && actual instanceof ObjectId
            ? candidate.equals(actual)
            : candidate === actual,
        );
      }
    }

    return actual === expected;
  });
}

function createDatabase(
  services: ServiceDocument[],
  users: MemoryRecord[] = [],
) {
  let serviceFilter: Record<string, unknown> | undefined;
  let userFilter: Record<string, unknown> | undefined;
  let userProjection: Record<string, unknown> | undefined;

  const database = {
    collection(name: string) {
      if (name === 'services') {
        return {
          find(filter: Record<string, unknown>) {
            serviceFilter = filter;
            let result = services.filter((item) => matches(item, filter));

            return {
              project() {
                return this;
              },
              sort() {
                return this;
              },
              limit(value: number) {
                result = result.slice(0, value);
                return this;
              },
              toArray: async () => result,
            };
          },
          findOne: async (filter: Record<string, unknown>) => {
            serviceFilter = filter;
            return services.find((item) => matches(item, filter)) ?? null;
          },
        };
      }

      if (name === 'user') {
        return {
          find(filter: Record<string, unknown>) {
            userFilter = filter;

            return {
              project(projection: Record<string, unknown>) {
                userProjection = projection;
                return this;
              },
              toArray: async () => users.filter((user) => matches(user, filter)),
            };
          },
          findOne: async (filter: Record<string, unknown>) =>
            users.find((user) => matches(user, filter)) ?? null,
        };
      }

      throw new Error('Unexpected collection.');
    },
  };

  return {
    database: database as unknown as Db,
    getServiceFilter: () => serviceFilter,
    getUserFilter: () => userFilter,
    getUserProjection: () => userProjection,
  };
}

/**
 * The production JWT middleware verifies tokens against the live auth server's
 * JWKS, which isolated tests cannot reach. This stand-in preserves its request
 * contract: missing credentials fail closed, and a verified identity is placed
 * on the request before the route handler runs.
 */
const testAuthenticate: RequestHandler = (request, _response, next) => {
  const role = request.get('x-test-role');
  const userId = request.get('x-test-user-id');

  if (!role || !userId) {
    next(new AppError('Authentication required.', 401, true, 'AUTHENTICATION_REQUIRED'));
    return;
  }

  request.authenticatedUser = {
    id: userId,
    email: 'viewer@example.com',
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

async function withServicesServer<T>(
  database: Db,
  action: (baseUrl: string) => Promise<T>,
  options: { authenticate?: RequestHandler } = {},
): Promise<T> {
  const app = express();
  app.use('/api/services', createPublicServicesRouter(database, options));
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

test('authenticated customer, vendor, and admin can read an approved active service', async () => {
  const approved = service();
  const database = createDatabase(
    [approved],
    [
      {
        _id: vendorObjectId,
        name: 'Ayesha Rahman',
        businessName: 'Ayesha Photography',
        email: 'private@example.com',
        password: 'private-hash',
        subscriptionPlan: 'premium',
        isBlocked: false,
      },
      { _id: new ObjectId(customerId), name: 'Customer', isBlocked: false },
      { _id: new ObjectId(otherVendorId), name: 'Other Vendor', isBlocked: false },
      { _id: new ObjectId(adminId), name: 'Admin', isBlocked: false },
    ],
  );

  await withServicesServer(
    database.database,
    async (baseUrl) => {
      for (const [role, userId] of [
        ['customer', customerId],
        ['vendor', otherVendorId],
        ['admin', adminId],
      ] as const) {
        const response = await fetch(
          `${baseUrl}/api/services/${approved._id.toHexString()}`,
          { headers: authHeaders(role, userId) },
        );

        assert.equal(response.status, 200, `${role} should be able to read the service`);
        const payload = (await response.json()) as {
          success: boolean;
          service: Record<string, unknown>;
        };

        assert.equal(payload.success, true);
        assert.deepEqual(payload.service, {
          id: approved._id.toHexString(),
          serviceName: approved.serviceName,
          category: approved.category,
          description: approved.description,
          price: approved.price,
          location: approved.location,
          images: approved.images,
          vendor: {
            name: 'Ayesha Rahman',
            businessName: 'Ayesha Photography',
          },
          createdAt: approved.createdAt.toISOString(),
          isOwner: false,
        });
        assert.equal(JSON.stringify(payload).includes('private@example.com'), false);
        assert.equal(JSON.stringify(payload).includes('private-hash'), false);
        assert.equal(JSON.stringify(payload).includes('subscriptionPlan'), false);
        assert.equal(JSON.stringify(payload).includes('vendorId'), false);
      }
    },
    { authenticate: testAuthenticate },
  );

  assert.deepEqual(database.getUserProjection(), { name: 1, businessName: 1 });
});

test('a vendor viewing their own approved service is marked as the owner', async () => {
  const approved = service();
  const database = createDatabase(
    [approved],
    [{ _id: vendorObjectId, name: 'Ayesha Rahman', businessName: 'Ayesha Photography' }],
  );

  await withServicesServer(
    database.database,
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/services/${approved._id.toHexString()}`,
        { headers: authHeaders('vendor', vendorId) },
      );
      assert.equal(response.status, 200);

      const payload = (await response.json()) as {
        service: { isOwner: boolean };
      };
      assert.equal(payload.service.isOwner, true);
    },
    { authenticate: testAuthenticate },
  );
});

test('the details endpoint is protected by the real authentication middleware', async () => {
  const approved = service();
  const database = createDatabase([approved]);

  await withServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services/${approved._id.toHexString()}`);
    assert.equal(response.status, 401);

    const payload = (await response.json()) as {
      success: boolean;
      error: { code?: string };
    };
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, 'AUTHENTICATION_REQUIRED');
  });

  // The route must reject the request before touching MongoDB.
  assert.equal(database.getServiceFilter(), undefined);
});

test('an invalid service ID returns 404 without querying MongoDB', async () => {
  const database = createDatabase(
    [service()],
    [{ _id: new ObjectId(customerId), name: 'Customer', isBlocked: false }],
  );

  await withServicesServer(
    database.database,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/services/not-a-valid-object-id`, {
        headers: authHeaders('customer', customerId),
      });
      assert.equal(response.status, 404);

      const payload = (await response.json()) as {
        success: boolean;
        error: { code?: string };
      };
      assert.equal(payload.success, false);
      assert.equal(payload.error.code, 'SERVICE_NOT_FOUND');
    },
    { authenticate: testAuthenticate },
  );

  assert.equal(database.getServiceFilter(), undefined);
});

test('a nonexistent service returns 404 and queries only approved active services', async () => {
  const database = createDatabase(
    [service()],
    [{ _id: new ObjectId(customerId), name: 'Customer', isBlocked: false }],
  );
  const missingId = new ObjectId().toHexString();

  await withServicesServer(
    database.database,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/services/${missingId}`, {
        headers: authHeaders('customer', customerId),
      });
      assert.equal(response.status, 404);
    },
    { authenticate: testAuthenticate },
  );

  const filter = database.getServiceFilter();
  assert.ok(filter?._id instanceof ObjectId);
  assert.equal((filter?._id as ObjectId).toHexString(), missingId);
  assert.equal(filter?.status, 'Approved');
  assert.equal(filter?.availability, true);
});

test('pending, rejected, and inactive services all return 404', async () => {
  for (const overrides of [
    { status: 'Pending' as const },
    { status: 'Rejected' as const },
    { availability: false },
  ]) {
    const hidden = service(overrides);
    const database = createDatabase(
      [hidden],
      [{ _id: new ObjectId(customerId), name: 'Customer', isBlocked: false }],
    );

    await withServicesServer(
      database.database,
      async (baseUrl) => {
        const response = await fetch(
          `${baseUrl}/api/services/${hidden._id.toHexString()}`,
          { headers: authHeaders('customer', customerId) },
        );
        assert.equal(
          response.status,
          404,
          `Expected 404 for ${JSON.stringify(overrides)}`,
        );
      },
      { authenticate: testAuthenticate },
    );

    const filter = database.getServiceFilter();
    assert.equal(filter?.status, 'Approved');
    assert.equal(filter?.availability, true);
  }
});

test('a missing vendor is handled safely and private fields are never selected', async () => {
  const approved = service();
  const database = createDatabase(
    [approved],
    [{ _id: new ObjectId(customerId), name: 'Customer', isBlocked: false }],
  );

  await withServicesServer(
    database.database,
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/services/${approved._id.toHexString()}`,
        { headers: authHeaders('customer', customerId) },
      );
      assert.equal(response.status, 200);

      const payload = (await response.json()) as {
        service: { vendor: unknown };
      };
      assert.equal(payload.service.vendor, null);
    },
    { authenticate: testAuthenticate },
  );

  const convertedIds = (database.getUserFilter()?._id as { $in?: ObjectId[] } | undefined)?.$in ?? [];
  assert.equal(convertedIds.length, 1);
  assert.ok(convertedIds[0] instanceof ObjectId);
  assert.equal(convertedIds[0]?.toHexString(), vendorId);
  assert.deepEqual(database.getUserProjection(), { name: 1, businessName: 1 });
});

test('a malformed vendor ID is handled without querying arbitrary user strings', async () => {
  const approved = service({ vendorId: 'not-an-object-id' });
  const database = createDatabase(
    [approved],
    [{ _id: new ObjectId(customerId), name: 'Customer', isBlocked: false }],
  );

  await withServicesServer(
    database.database,
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/services/${approved._id.toHexString()}`,
        { headers: authHeaders('customer', customerId) },
      );
      assert.equal(response.status, 200);

      const payload = (await response.json()) as {
        service: { vendor: unknown };
      };
      assert.equal(payload.service.vendor, null);
    },
    { authenticate: testAuthenticate },
  );

  assert.equal(database.getUserFilter(), undefined);
});

test('featured and listing routes keep working and are not shadowed by the details route', async () => {
  const approved = service();
  const database = createDatabase([approved], [
    { _id: vendorObjectId, name: 'Ayesha Rahman', businessName: 'Ayesha Photography' },
  ]);

  await withServicesServer(database.database, async (baseUrl) => {
    const featured = await fetch(`${baseUrl}/api/services/featured`);
    assert.equal(featured.status, 200);
    const featuredPayload = (await featured.json()) as {
      services: Array<{ id: string }>;
    };
    assert.deepEqual(
      featuredPayload.services.map((item) => item.id),
      [approved._id.toHexString()],
    );

    const listing = await fetch(`${baseUrl}/api/services`);
    assert.equal(listing.status, 200);
    const listingPayload = (await listing.json()) as {
      services: Array<{ id: string }>;
    };
    assert.deepEqual(
      listingPayload.services.map((item) => item.id),
      [approved._id.toHexString()],
    );
  });
});
