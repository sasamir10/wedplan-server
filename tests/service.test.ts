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
import { AppError } from '../src/utils/app-error.js';

type MemoryDocument = Record<string, unknown> & { _id: string | ObjectId };

const vendorOneObjectId = new ObjectId();
const VENDOR_ONE_ID = vendorOneObjectId.toHexString();
const VENDOR_TWO_ID = new ObjectId().toHexString();

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
  // Better Auth stores user._id as an ObjectId; service vendorId stays a hex string.
  const users: MemoryDocument[] = [
    { _id: vendorOneObjectId, subscriptionPlan: plan },
  ];
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
    users,
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
  const service = await createService(database, client, VENDOR_ONE_ID, { ...validInput });

  assert.equal(service.vendorId, VENDOR_ONE_ID);
  assert.equal(service.status, 'Pending');
  assert.equal(service.availability, true);
  assert.equal(services.length, 1);
});

test('lists only services owned by the requested vendor', async () => {
  const { database } = createMemoryDatabase('free', [
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_TWO_ID, true),
  ]);

  const result = await getVendorServices(database, VENDOR_ONE_ID);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.vendorId, VENDOR_ONE_ID);
});

test('updates an owned service without allowing approval-field changes', async () => {
  const ownedService = serviceRecord(VENDOR_ONE_ID, true);
  const { database } = createMemoryDatabase('free', [ownedService]);
  const updated = await updateVendorService(database, VENDOR_ONE_ID, ownedService._id.toHexString(), {
    serviceName: 'Updated wedding photography',
  });

  assert.equal(updated.serviceName, 'Updated wedding photography');
  assert.equal(updated.status, 'Pending');
});

test('cannot update or delete a service owned by another vendor', async () => {
  const foreignService = serviceRecord(VENDOR_TWO_ID, true);
  const { database, client, services } = createMemoryDatabase('free', [foreignService]);

  await assert.rejects(
    () => updateVendorService(database, VENDOR_ONE_ID, foreignService._id.toHexString(), {
      serviceName: 'Changed title',
    }),
    { statusCode: 404 },
  );
  await assert.rejects(
    () => deleteVendorService(database, client, VENDOR_ONE_ID, foreignService._id.toHexString()),
    { statusCode: 404 },
  );
  assert.equal(services.length, 1);
});

test('validates MongoDB service IDs before querying', async () => {
  const { database } = createMemoryDatabase('free');
  await assert.rejects(
    () => updateVendorService(database, VENDOR_ONE_ID, 'not-an-object-id', {
      serviceName: 'Changed title',
    }),
    { statusCode: 400 },
  );
});

test('blocks Free vendors from creating a fourth available service', async () => {
  const { database, client } = createMemoryDatabase('free', [
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_ONE_ID, true),
  ]);

  await assert.rejects(
    () => createService(database, client, VENDOR_ONE_ID, { ...validInput }),
    { statusCode: 409, code: 'FREE_PLAN_LIMIT_REACHED' },
  );
});

test('counts Pending, Approved, and Rejected services when availability is true', async () => {
  const services = [
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_ONE_ID, true),
  ];
  services[1]!.status = 'Approved';
  services[2]!.status = 'Rejected';
  const { database, client } = createMemoryDatabase('free', services);

  await assert.rejects(
    () => createService(database, client, VENDOR_ONE_ID, { ...validInput }),
    { statusCode: 409 },
  );
});

test('concurrent Free vendor creation cannot exceed three active services', async () => {
  const { database, client, services } = createMemoryDatabase('free');
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      createService(database, client, VENDOR_ONE_ID, { ...validInput }),
    ),
  );

  assert.equal(services.filter((service) => service.availability).length, 3);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 5);
});

test('blocks Free vendor activation at the limit and permits it after deactivation', async () => {
  const active = [
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_ONE_ID, true),
  ];
  const unavailable = serviceRecord(VENDOR_ONE_ID, false);
  const { database, client } = createMemoryDatabase('free', [...active, unavailable]);

  await assert.rejects(
    () => updateVendorServiceAvailability(
      database,
      client,
      VENDOR_ONE_ID,
      unavailable._id.toHexString(),
      true,
    ),
    { statusCode: 409 },
  );

  await updateVendorServiceAvailability(
    database,
    client,
    VENDOR_ONE_ID,
    active[0]!._id.toHexString(),
    false,
  );
  const activated = await updateVendorServiceAvailability(
    database,
    client,
    VENDOR_ONE_ID,
    unavailable._id.toHexString(),
    true,
  );

  assert.equal(activated.availability, true);
});

test('deleting an owned available service frees a Free-plan active slot', async () => {
  const active = [
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_ONE_ID, true),
  ];
  const { database, client, services } = createMemoryDatabase('free', active);

  await deleteVendorService(database, client, VENDOR_ONE_ID, active[0]!._id.toHexString());
  const created = await createService(database, client, VENDOR_ONE_ID, { ...validInput });

  assert.equal(created.availability, true);
  assert.equal(services.filter((service) => service.availability).length, 3);
});

test('concurrent Free vendor activations allow only the remaining slot', async () => {
  const unavailable = [serviceRecord(VENDOR_ONE_ID, false), serviceRecord(VENDOR_ONE_ID, false)];
  const { database, client, services } = createMemoryDatabase('free', [
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_ONE_ID, true),
    ...unavailable,
  ]);
  const results = await Promise.allSettled(
    unavailable.map((service) =>
      updateVendorServiceAvailability(
        database,
        client,
        VENDOR_ONE_ID,
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
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_ONE_ID, true),
  ]);

  await assert.rejects(
    () => createService(database, client, VENDOR_ONE_ID, { ...validInput }),
    { statusCode: 409 },
  );
  assert.equal(getEndedSessionCount(), 1);
});

test('Premium vendors are not subject to the Free active-service limit', async () => {
  const { database, client } = createMemoryDatabase('premium', [
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_ONE_ID, true),
    serviceRecord(VENDOR_ONE_ID, true),
  ]);

  const created = await createService(database, client, VENDOR_ONE_ID, { ...validInput });
  assert.equal(created.availability, true);
});

test('resolves the ObjectId-backed vendor while storing vendorId as a hex string', async () => {
  const { database, client, users } = createMemoryDatabase('free');
  const created = await createService(database, client, VENDOR_ONE_ID, { ...validInput });

  assert.ok(users[0]?._id instanceof ObjectId);
  assert.equal(users[0]?._id.toHexString(), VENDOR_ONE_ID);
  assert.equal(typeof created.vendorId, 'string');
  assert.equal(created.vendorId, VENDOR_ONE_ID);
  assert.equal(created.status, 'Pending');
});

test('rejects invalid vendor IDs without matching arbitrary strings', async () => {
  const { database, client, services } = createMemoryDatabase('free');

  await assert.rejects(
    () => createService(database, client, 'not-an-object-id', { ...validInput }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 403 &&
      error.code === 'VENDOR_ACCOUNT_UNAVAILABLE',
  );
  assert.equal(services.length, 0);
});

test('rejects a valid ObjectId that does not belong to an existing vendor', async () => {
  const { database, client, services } = createMemoryDatabase('free');

  await assert.rejects(
    () =>
      createService(database, client, new ObjectId().toHexString(), {
        ...validInput,
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 403 &&
      error.code === 'VENDOR_ACCOUNT_UNAVAILABLE',
  );
  assert.equal(services.length, 0);
});

test('reports an unverifiable subscription plan separately from a missing vendor', async () => {
  const { database, client, users } = createMemoryDatabase('free');
  users[0]!.subscriptionPlan = 'trial';

  await assert.rejects(
    () => createService(database, client, VENDOR_ONE_ID, { ...validInput }),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 403 &&
      error.code === 'SUBSCRIPTION_UNVERIFIED',
  );
});

test('cannot change availability for a service owned by another vendor', async () => {
  const foreignService = serviceRecord(VENDOR_TWO_ID, false);
  const { database, client, services } = createMemoryDatabase('free', [
    foreignService,
  ]);

  await assert.rejects(
    () =>
      updateVendorServiceAvailability(
        database,
        client,
        VENDOR_ONE_ID,
        foreignService._id.toHexString(),
        true,
      ),
    { statusCode: 404, code: 'SERVICE_NOT_FOUND' },
  );
  assert.equal(services[0]?.availability, false);
});

test('missing services cannot be deleted', async () => {
  const { database, client } = createMemoryDatabase('free');

  await assert.rejects(
    () =>
      deleteVendorService(
        database,
        client,
        VENDOR_ONE_ID,
        new ObjectId().toHexString(),
      ),
    { statusCode: 404, code: 'SERVICE_NOT_FOUND' },
  );
});

