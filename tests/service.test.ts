import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId, type ClientSession, type Db, type MongoClient } from 'mongodb';
import {
  createServiceSchema,
  updateAvailabilitySchema,
  updateServiceSchema,
  type CreateServiceInput,
} from '../src/models/service.js';
import {
  createService,
  deleteVendorService,
  getVendorServices,
  updateVendorService,
  updateVendorServiceAvailability,
  type ServiceDocument,
} from '../src/services/service.service.js';

type MemoryDocument = Record<string, unknown> & { _id: string | ObjectId };

function matches(document: MemoryDocument, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const actual = document[key];
    if (actual instanceof ObjectId && value instanceof ObjectId) {
      return actual.equals(value);
    }
    return actual === value;
  });
}

function createMemoryDatabase(plan: 'free' | 'premium', initialServices: ServiceDocument[] = []) {
  const users: MemoryDocument[] = [{ _id: 'vendor-1', subscriptionPlan: plan }];
  const services = [...initialServices] as MemoryDocument[];
  let lockTail = Promise.resolve();
  let endedSessionCount = 0;

  async function acquireVendorLock(): Promise<() => void> {
    const previousLock = lockTail;
    let releaseLock!: () => void;
    lockTail = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previousLock;
    return releaseLock;
  }

  const database = {
    collection(name: string) {
      if (name === 'user') {
        return {
          findOne: async (filter: Record<string, unknown>) =>
            users.find((user) => matches(user, filter)) ?? null,
          updateOne: async (
            filter: Record<string, unknown>,
            update: { $inc: Record<string, number> },
            options?: { session?: ClientSession },
          ) => {
            const session = options?.session as (ClientSession & {
              acquireVendorLock?: () => Promise<void>;
            }) | undefined;
            await session?.acquireVendorLock?.();
            const user = users.find((entry) => matches(entry, filter));
            if (!user) return { matchedCount: 0 };
            for (const [key, amount] of Object.entries(update.$inc)) {
              user[key] = Number(user[key] ?? 0) + amount;
            }
            return { matchedCount: 1 };
          },
        };
      }

      if (name !== 'services') throw new Error('Unexpected collection.');

      return {
        find: (filter: Record<string, unknown>) => {
          const result = services.filter((service) => matches(service, filter));
          return {
            sort: () => ({ toArray: async () => result }),
            toArray: async () => result,
          };
        },
        findOne: async (filter: Record<string, unknown>) =>
          services.find((service) => matches(service, filter)) ?? null,
        countDocuments: async (filter: Record<string, unknown>) =>
          services.filter((service) => matches(service, filter)).length,
        insertOne: async (service: ServiceDocument) => {
          services.push(service as unknown as MemoryDocument);
          return { insertedId: service._id };
        },
        findOneAndUpdate: async (
          filter: Record<string, unknown>,
          update: { $set: Record<string, unknown> },
        ) => {
          const service = services.find((entry) => matches(entry, filter));
          if (!service) return null;
          Object.assign(service, update.$set);
          return service;
        },
        deleteOne: async (filter: Record<string, unknown>) => {
          const index = services.findIndex((entry) => matches(entry, filter));
          if (index < 0) return { deletedCount: 0 };
          services.splice(index, 1);
          return { deletedCount: 1 };
        },
      };
    },
  };

  const client = {
    startSession: () => {
      let releaseLock: (() => void) | undefined;
      return {
        acquireVendorLock: async () => {
          releaseLock ??= await acquireVendorLock();
        },
        withTransaction: async <T>(operation: () => Promise<T>) => {
          try {
            return await operation();
          } finally {
            releaseLock?.();
            releaseLock = undefined;
          }
        },
        endSession: async () => {
          endedSessionCount += 1;
          releaseLock?.();
          releaseLock = undefined;
        },
      };
    },
  };

  return {
    database: database as unknown as Db,
    client: client as unknown as MongoClient,
    services,
    getEndedSessionCount: () => endedSessionCount,
  };
}

const validInput: CreateServiceInput = {
  serviceName: 'Wedding Photography',
  category: 'Photography & Videography',
  description: 'Full day wedding photography coverage and edited gallery.',
  price: 1200,
  location: 'Dhaka',
  images: ['https://images.example.com/wedding.jpg'],
};

function serviceRecord(vendorId: string, availability: boolean): ServiceDocument {
  const now = new Date();
  return {
    _id: new ObjectId(),
    vendorId,
    ...validInput,
    images: [...validInput.images],
    status: 'Pending',
    availability,
    createdAt: now,
    updatedAt: now,
  };
}

test('create schema accepts valid service data and rejects ownership or approval fields', () => {
  assert.equal(createServiceSchema.safeParse(validInput).success, true);
  assert.equal(
    createServiceSchema.safeParse({ ...validInput, vendorId: 'client-id' }).success,
    false,
  );
  assert.equal(
    createServiceSchema.safeParse({ ...validInput, status: 'Approved' }).success,
    false,
  );
  assert.equal(
    createServiceSchema.safeParse({ ...validInput, availability: false }).success,
    false,
  );
  assert.equal(updateServiceSchema.safeParse({ status: 'Rejected' }).success, false);
});

test('availability endpoint accepts only a boolean availability field', () => {
  assert.equal(updateAvailabilitySchema.safeParse({ availability: false }).success, true);
  assert.equal(
    updateAvailabilitySchema.safeParse({ availability: true, status: 'Approved' }).success,
    false,
  );
});

test('creates Pending available service for the authenticated vendor', async () => {
  const { database, client, services } = createMemoryDatabase('free');
  const service = await createService(database, client, 'vendor-1', { ...validInput });

  assert.equal(service.vendorId, 'vendor-1');
  assert.equal(service.status, 'Pending');
  assert.equal(service.availability, true);
  assert.equal(services.length, 1);
});

test('lists only services owned by the requested vendor', async () => {
  const { database } = createMemoryDatabase('free', [
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-2', true),
  ]);

  const result = await getVendorServices(database, 'vendor-1');
  assert.equal(result.length, 1);
  assert.equal(result[0]?.vendorId, 'vendor-1');
});

test('updates an owned service without allowing approval-field changes', async () => {
  const ownedService = serviceRecord('vendor-1', true);
  const { database } = createMemoryDatabase('free', [ownedService]);
  const updated = await updateVendorService(database, 'vendor-1', ownedService._id.toHexString(), {
    serviceName: 'Updated wedding photography',
  });

  assert.equal(updated.serviceName, 'Updated wedding photography');
  assert.equal(updated.status, 'Pending');
});

test('cannot update or delete a service owned by another vendor', async () => {
  const foreignService = serviceRecord('vendor-2', true);
  const { database, client, services } = createMemoryDatabase('free', [foreignService]);

  await assert.rejects(
    () => updateVendorService(database, 'vendor-1', foreignService._id.toHexString(), {
      serviceName: 'Changed title',
    }),
    { statusCode: 404 },
  );
  await assert.rejects(
    () => deleteVendorService(database, client, 'vendor-1', foreignService._id.toHexString()),
    { statusCode: 404 },
  );
  assert.equal(services.length, 1);
});

test('validates MongoDB service IDs before querying', async () => {
  const { database } = createMemoryDatabase('free');
  await assert.rejects(
    () => updateVendorService(database, 'vendor-1', 'not-an-object-id', {
      serviceName: 'Changed title',
    }),
    { statusCode: 400 },
  );
});

test('blocks Free vendors from creating a fourth available service', async () => {
  const { database, client } = createMemoryDatabase('free', [
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-1', true),
  ]);

  await assert.rejects(
    () => createService(database, client, 'vendor-1', { ...validInput }),
    { statusCode: 409 },
  );
});

test('counts Pending, Approved, and Rejected services when availability is true', async () => {
  const services = [
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-1', true),
  ];
  services[1]!.status = 'Approved';
  services[2]!.status = 'Rejected';
  const { database, client } = createMemoryDatabase('free', services);

  await assert.rejects(
    () => createService(database, client, 'vendor-1', { ...validInput }),
    { statusCode: 409 },
  );
});

test('concurrent Free vendor creation cannot exceed three active services', async () => {
  const { database, client, services } = createMemoryDatabase('free');
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      createService(database, client, 'vendor-1', { ...validInput }),
    ),
  );

  assert.equal(services.filter((service) => service.availability).length, 3);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 5);
});

test('blocks Free vendor activation at the limit and permits it after deactivation', async () => {
  const active = [
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-1', true),
  ];
  const unavailable = serviceRecord('vendor-1', false);
  const { database, client } = createMemoryDatabase('free', [...active, unavailable]);

  await assert.rejects(
    () => updateVendorServiceAvailability(
      database,
      client,
      'vendor-1',
      unavailable._id.toHexString(),
      true,
    ),
    { statusCode: 409 },
  );

  await updateVendorServiceAvailability(
    database,
    client,
    'vendor-1',
    active[0]!._id.toHexString(),
    false,
  );
  const activated = await updateVendorServiceAvailability(
    database,
    client,
    'vendor-1',
    unavailable._id.toHexString(),
    true,
  );

  assert.equal(activated.availability, true);
});

test('deleting an owned available service frees a Free-plan active slot', async () => {
  const active = [
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-1', true),
  ];
  const { database, client, services } = createMemoryDatabase('free', active);

  await deleteVendorService(database, client, 'vendor-1', active[0]!._id.toHexString());
  const created = await createService(database, client, 'vendor-1', { ...validInput });

  assert.equal(created.availability, true);
  assert.equal(services.filter((service) => service.availability).length, 3);
});

test('concurrent Free vendor activations allow only the remaining slot', async () => {
  const unavailable = [serviceRecord('vendor-1', false), serviceRecord('vendor-1', false)];
  const { database, client, services } = createMemoryDatabase('free', [
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-1', true),
    ...unavailable,
  ]);
  const results = await Promise.allSettled(
    unavailable.map((service) =>
      updateVendorServiceAvailability(
        database,
        client,
        'vendor-1',
        service._id.toHexString(),
        true,
      ),
    ),
  );

  assert.equal(services.filter((service) => service.availability).length, 3);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('closes the MongoDB session when a subscription limit aborts a transaction', async () => {
  const { database, client, getEndedSessionCount } = createMemoryDatabase('free', [
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-1', true),
  ]);

  await assert.rejects(
    () => createService(database, client, 'vendor-1', { ...validInput }),
    { statusCode: 409 },
  );
  assert.equal(getEndedSessionCount(), 1);
});

test('Premium vendors are not subject to the Free active-service limit', async () => {
  const { database, client } = createMemoryDatabase('premium', [
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-1', true),
    serviceRecord('vendor-1', true),
  ]);

  const created = await createService(database, client, 'vendor-1', { ...validInput });
  assert.equal(created.availability, true);
});

