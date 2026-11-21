import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { test } from 'node:test';
import { ObjectId, type Db } from 'mongodb';
import type { ServiceDocument } from '../src/services/service.service.js';
import { createPublicServicesRouter } from '../src/routes/public-services.routes.js';
import { errorHandler } from '../src/middleware/error-handler.js';

type MemoryRecord = Record<string, unknown>;

function service(
  vendorId: string,
  status: ServiceDocument['status'],
  availability: boolean,
  createdAt = new Date('2026-11-21T00:00:00.000Z'),
): ServiceDocument {
  return {
    _id: new ObjectId(),
    vendorId,
    serviceName: 'Wedding Photography',
    category: 'Photography & Videography',
    description: 'Full-day wedding photography with an edited gallery.',
    price: 1200,
    location: 'Dhaka',
    images: ['https://images.example.com/wedding.jpg'],
    status,
    availability,
    createdAt,
    updatedAt: createdAt,
  };
}

function createDatabase(services: ServiceDocument[], users: MemoryRecord[] = []) {
  let serviceFilter: Record<string, unknown> | undefined;
  let serviceLimit: number | undefined;
  let serviceSort: Record<string, 1 | -1> | undefined;
  let userProjection: Record<string, unknown> | undefined;

  const database = {
    collection(name: string) {
      if (name === 'services') {
        return {
          find(filter: Record<string, unknown>) {
            serviceFilter = filter;
            let result = services.filter((item) =>
              Object.entries(filter).every(([field, expected]) => {
                const actual = item[field as keyof ServiceDocument];
                if (typeof expected === 'object' && expected !== null && '$regex' in expected) {
                  const matcher = expected as { $regex: string; $options?: string };
                  return (
                    typeof actual === 'string' &&
                    new RegExp(matcher.$regex, matcher.$options).test(actual)
                  );
                }
                return actual === expected;
              }),
            );
            return {
              project() {
                return this;
              },
              sort(specification: Record<string, 1 | -1>) {
                serviceSort = specification;
                const sortFields = Object.entries(specification) as Array<[string, 1 | -1]>;
                result = [...result].sort((first, second) => {
                  for (const [field, direction] of sortFields) {
                    let difference = 0;
                    if (field === 'price') difference = first.price - second.price;
                    if (field === 'createdAt') {
                      difference = first.createdAt.getTime() - second.createdAt.getTime();
                    }
                    if (field === '_id') {
                      difference = first._id.toHexString().localeCompare(second._id.toHexString());
                    }
                    if (difference !== 0) return difference * direction;
                  }
                  return 0;
                });
                return this;
              },
              limit(value: number) {
                serviceLimit = value;
                result = result.slice(0, value);
                return this;
              },
              toArray: async () => result,
            };
          },
        };
      }

      if (name === 'user') {
        return {
          find(filter: { _id: { $in: string[] } }) {
            return {
              project(projection: Record<string, unknown>) {
                userProjection = projection;
                return this;
              },
              toArray: async () =>
                users
                  .filter((user) => filter._id.$in.includes(String(user._id)))
                  .map((user) => ({
                    _id: user._id,
                    name: user.name,
                    businessName: user.businessName,
                  })),
            };
          },
        };
      }

      throw new Error('Unexpected collection.');
    },
  };

  return {
    database: database as unknown as Db,
    getServiceFilter: () => serviceFilter,
    getServiceLimit: () => serviceLimit,
    getServiceSort: () => serviceSort,
    getUserProjection: () => userProjection,
  };
}

async function withPublicServicesServer<T>(
  database: Db,
  action: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use('/api/services', createPublicServicesRouter(database));
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

test('public services are unauthenticated and include approved active services with safe vendor display fields', async () => {
  const visible = service('vendor-1', 'Approved', true);
  const database = createDatabase(
    [
      visible,
      service('vendor-1', 'Pending', true),
      service('vendor-1', 'Rejected', true),
      service('vendor-1', 'Approved', false),
    ],
    [
      {
        _id: 'vendor-1',
        name: 'Ayesha Rahman',
        businessName: 'Ayesha Photography',
        email: 'private@example.com',
        password: 'private-hash',
        role: 'vendor',
      },
    ],
  );

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      success: boolean;
      services: Array<Record<string, unknown>>;
    };

    assert.equal(payload.success, true);
    assert.equal(payload.services.length, 1);
    assert.equal(payload.services[0]?.serviceName, visible.serviceName);
    assert.deepEqual(payload.services[0]?.images, visible.images);
    assert.deepEqual(payload.services[0]?.vendor, {
      name: 'Ayesha Rahman',
      businessName: 'Ayesha Photography',
    });
    assert.equal(JSON.stringify(payload).includes('private@example.com'), false);
    assert.equal(JSON.stringify(payload).includes('private-hash'), false);
  });

  assert.deepEqual(database.getServiceFilter(), { status: 'Approved', availability: true });
  assert.deepEqual(database.getUserProjection(), { name: 1, businessName: 1 });
});

test('public services returns an empty list when no approved active services exist', async () => {
  const database = createDatabase([service('vendor-1', 'Pending', true)]);

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, services: [] });
  });
});

test('public services represents a missing vendor record without failing or exposing internals', async () => {
  const database = createDatabase([service('deleted-vendor', 'Approved', true)]);

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      services: Array<{ vendor: unknown }>;
    };
    assert.equal(payload.services[0]?.vendor, null);
  });
});

test('public search performs case-insensitive partial matching on service names', async () => {
  const match = service('vendor-1', 'Approved', true);
  match.serviceName = 'Wedding Photography Package';
  const nonMatch = service('vendor-1', 'Approved', true);
  nonMatch.serviceName = 'Wedding Venue';
  const database = createDatabase([
    match,
    nonMatch,
    service('vendor-1', 'Pending', true),
  ]);

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services?search=PHOTOGRAPHY`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { services: Array<{ id: string }> };
    assert.deepEqual(payload.services.map((item) => item.id), [match._id.toHexString()]);
  });
});

test('public category filtering matches an existing category exactly', async () => {
  const venue = service('vendor-1', 'Approved', true);
  venue.category = 'Wedding Venues';
  const photography = service('vendor-1', 'Approved', true);
  const database = createDatabase([venue, photography]);
  const query = new URLSearchParams({ category: 'Wedding Venues' });

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services?${query}`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { services: Array<{ id: string }> };
    assert.deepEqual(payload.services.map((item) => item.id), [venue._id.toHexString()]);
  });
});

test('public location filtering performs case-insensitive partial matching', async () => {
  const match = service('vendor-1', 'Approved', true);
  match.location = 'Central Sylhet District';
  const database = createDatabase([match, service('vendor-1', 'Approved', true)]);

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services?location=sYLh`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { services: Array<{ id: string }> };
    assert.deepEqual(payload.services.map((item) => item.id), [match._id.toHexString()]);
  });
});

test('public search, category, and location filters combine using AND behavior', async () => {
  const matching = service('vendor-1', 'Approved', true);
  matching.serviceName = 'Wedding Photography Package';
  matching.location = 'North Dhaka';
  const wrongCategory = service('vendor-1', 'Approved', true);
  wrongCategory.serviceName = matching.serviceName;
  wrongCategory.location = matching.location;
  wrongCategory.category = 'Wedding Venues';
  const wrongLocation = service('vendor-1', 'Approved', true);
  wrongLocation.serviceName = matching.serviceName;
  wrongLocation.location = 'Chattogram';
  const wrongName = service('vendor-1', 'Approved', true);
  wrongName.serviceName = 'Wedding Celebration';
  wrongName.location = matching.location;
  const unpublished = service('vendor-1', 'Pending', true);
  unpublished.serviceName = matching.serviceName;
  unpublished.location = matching.location;
  const inactive = service('vendor-1', 'Approved', false);
  inactive.serviceName = matching.serviceName;
  inactive.location = matching.location;
  const database = createDatabase([
    matching,
    wrongCategory,
    wrongLocation,
    wrongName,
    unpublished,
    inactive,
  ]);
  const query = new URLSearchParams({
    search: '  PHOTOgraphy  ',
    category: 'Photography & Videography',
    location: '  DhAkA ',
  });

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services?${query}`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { services: Array<{ id: string }> };
    assert.deepEqual(payload.services.map((item) => item.id), [matching._id.toHexString()]);
  });
});

test('empty text filters are ignored and regex metacharacters are treated literally', async () => {
  const eligible = service('vendor-1', 'Approved', true);
  const database = createDatabase([eligible, service('vendor-1', 'Pending', true)]);

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const unfiltered = await fetch(`${baseUrl}/api/services?search=%20%20&location=%20`);
    assert.equal(unfiltered.status, 200);
    const allEligible = (await unfiltered.json()) as { services: Array<{ id: string }> };
    assert.deepEqual(allEligible.services.map((item) => item.id), [eligible._id.toHexString()]);

    const literal = await fetch(`${baseUrl}/api/services?search=${encodeURIComponent('.*')}`);
    assert.equal(literal.status, 200);
    assert.deepEqual(await literal.json(), { success: true, services: [] });
  });
});

test('unsupported public service categories return a validation error', async () => {
  const database = createDatabase([]);

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services?category=Not%20A%20Category`);
    assert.equal(response.status, 400);
  });
});

test('default public service ordering remains newest first', async () => {
  const older = service('vendor-1', 'Approved', true, new Date('2026-11-19T00:00:00Z'));
  const newer = service('vendor-1', 'Approved', true, new Date('2026-11-20T00:00:00Z'));
  const database = createDatabase([older, newer]);

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const expected = [
      newer._id.toHexString(),
      older._id.toHexString(),
    ];
    const response = await fetch(`${baseUrl}/api/services`);
    const payload = (await response.json()) as { services: Array<{ id: string }> };
    assert.deepEqual(payload.services.map((item) => item.id), expected);

    const explicitDefault = await fetch(`${baseUrl}/api/services?sort=default`);
    const explicitPayload = (await explicitDefault.json()) as { services: Array<{ id: string }> };
    assert.deepEqual(explicitPayload.services.map((item) => item.id), expected);
  });

  assert.deepEqual(database.getServiceSort(), { createdAt: -1, _id: -1 });
});

test('public price sorting uses numeric ascending and descending order', async () => {
  const prices = [5000, 12000, 25000, 50000];
  const services = prices.map((price) => ({
    ...service('vendor-1', 'Approved', true),
    price,
  }));
  const database = createDatabase(services);

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const lowToHigh = await fetch(`${baseUrl}/api/services?sort=price-asc`);
    assert.deepEqual(
      ((await lowToHigh.json()) as { services: Array<{ price: number }> }).services.map(
        (item) => item.price,
      ),
      prices,
    );
    assert.deepEqual(database.getServiceSort(), {
      price: 1,
      createdAt: -1,
      _id: -1,
    });

    const highToLow = await fetch(`${baseUrl}/api/services?sort=price-desc`);
    assert.deepEqual(
      ((await highToLow.json()) as { services: Array<{ price: number }> }).services.map(
        (item) => item.price,
      ),
      [...prices].reverse(),
    );
    assert.deepEqual(database.getServiceSort(), {
      price: -1,
      createdAt: -1,
      _id: -1,
    });
  });
});

test('equal public prices use newest date and ID as deterministic tie-breakers', async () => {
  const oldest = service('vendor-1', 'Approved', true, new Date('2026-11-19T00:00:00Z'));
  const latest = service('vendor-1', 'Approved', true, new Date('2026-11-21T00:00:00Z'));
  const sameDateLaterId = service('vendor-1', 'Approved', true, latest.createdAt);
  for (const item of [oldest, latest, sameDateLaterId]) item.price = 12000;
  const database = createDatabase([oldest, latest, sameDateLaterId]);

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services?sort=price-asc`);
    const payload = (await response.json()) as { services: Array<{ id: string }> };
    assert.deepEqual(payload.services.map((item) => item.id), [
      sameDateLaterId._id.toHexString(),
      latest._id.toHexString(),
      oldest._id.toHexString(),
    ]);
  });
});

test('price sorting combines with search, category, and location filters', async () => {
  const lowerPrice = service('vendor-1', 'Approved', true);
  lowerPrice.serviceName = 'Wedding Photography Basic';
  lowerPrice.location = 'Dhaka North';
  lowerPrice.price = 12000;
  const higherPrice = service('vendor-1', 'Approved', true);
  higherPrice.serviceName = 'Wedding Photography Premium';
  higherPrice.location = 'Dhaka South';
  higherPrice.price = 25000;
  const wrongCategory = service('vendor-1', 'Approved', true);
  wrongCategory.serviceName = 'Wedding Photography Venue';
  wrongCategory.location = 'Dhaka';
  wrongCategory.category = 'Wedding Venues';
  wrongCategory.price = 5000;
  const inactive = service('vendor-1', 'Approved', false);
  inactive.serviceName = 'Wedding Photography inactive';
  inactive.location = 'Dhaka';
  inactive.price = 5000;
  const unpublished = service('vendor-1', 'Pending', true);
  unpublished.serviceName = 'Wedding Photography pending';
  unpublished.location = 'Dhaka';
  unpublished.price = 5000;
  const database = createDatabase([
    lowerPrice,
    higherPrice,
    wrongCategory,
    inactive,
    unpublished,
  ]);
  const query = new URLSearchParams({
    search: 'photography',
    category: 'Photography & Videography',
    location: 'dhaka',
    sort: 'price-desc',
  });

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services?${query}`);
    const payload = (await response.json()) as { services: Array<{ id: string; price: number }> };
    assert.deepEqual(
      payload.services.map((item) => [item.id, item.price]),
      [
        [higherPrice._id.toHexString(), 25000],
        [lowerPrice._id.toHexString(), 12000],
      ],
    );
  });
});

test('unsupported public price sort values return a validation error', async () => {
  const database = createDatabase([]);

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services?sort=price-random`);
    assert.equal(response.status, 400);
  });
});

test('featured endpoint returns no more than six newest approved active services', async () => {
  const services = Array.from({ length: 8 }, (_, index) =>
    service(
      'vendor-1',
      'Approved',
      true,
      new Date(`2026-11-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
    ),
  );
  services.push(
    service('vendor-1', 'Pending', true),
    service('vendor-1', 'Rejected', true),
    service('vendor-1', 'Approved', false),
  );
  const database = createDatabase(services, [{ _id: 'vendor-1', name: 'Vendor' }]);

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services/featured`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      success: boolean;
      services: Array<{ createdAt: string }>;
    };

    assert.equal(payload.success, true);
    assert.equal(payload.services.length, 6);
    assert.deepEqual(
      payload.services.map((item) => item.createdAt),
      [...payload.services.map((item) => item.createdAt)].sort().reverse(),
    );
  });

  assert.equal(database.getServiceLimit(), 6);
  assert.deepEqual(database.getServiceSort(), { createdAt: -1, _id: -1 });
});

test('featured endpoint returns fewer than six services and handles the empty state', async () => {
  const database = createDatabase([service('vendor-1', 'Approved', true)]);

  await withPublicServicesServer(database.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services/featured`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { services: unknown[] };
    assert.equal(payload.services.length, 1);
  });

  const emptyDatabase = createDatabase([]);
  await withPublicServicesServer(emptyDatabase.database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/services/featured`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, services: [] });
  });
});
