import {
  ObjectId,
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type MongoClient,
} from 'mongodb';
import type {
  CreateServiceInput,
  ServiceCategory,
  ServiceStatus,
  UpdateServiceInput,
} from '../models/service.js';
import { AppError } from '../utils/app-error.js';

export interface ServiceDocument extends Document {
  _id: ObjectId;
  vendorId: string;
  serviceName: string;
  category: ServiceCategory;
  description: string;
  price: number;
  location: string;
  images: string[];
  status: ServiceStatus;
  availability: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface VendorDocument extends Document {
  _id: string;
  subscriptionPlan?: unknown;
}

export interface ServiceResponse {
  id: string;
  vendorId: string;
  serviceName: string;
  category: ServiceCategory;
  description: string;
  price: number;
  location: string;
  images: string[];
  status: ServiceStatus;
  availability: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const FREE_ACTIVE_SERVICE_LIMIT = 3;

function serviceCollection(database: Db): Collection<ServiceDocument> {
  return database.collection<ServiceDocument>('services');
}

function toServiceResponse(service: ServiceDocument): ServiceResponse {
  return {
    id: service._id.toHexString(),
    vendorId: service.vendorId,
    serviceName: service.serviceName,
    category: service.category,
    description: service.description,
    price: service.price,
    location: service.location,
    images: service.images,
    status: service.status,
    availability: service.availability,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
  };
}

function parseServiceId(value: string): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new AppError('Invalid service ID.', 400);
  }

  return new ObjectId(value);
}

async function assertVendorPlan(
  database: Db,
  vendorId: string,
  session?: ClientSession,
): Promise<'free' | 'premium'> {
  // Better Auth's default MongoDB model name is "user"; IDs are stored as strings.
  const vendor = await database
    .collection<VendorDocument>('user')
    .findOne({ _id: vendorId }, { session });

  if (!vendor || (vendor.subscriptionPlan !== 'free' && vendor.subscriptionPlan !== 'premium')) {
    throw new AppError('Vendor subscription could not be verified.', 403);
  }

  return vendor.subscriptionPlan;
}

async function lockVendorServiceChanges(
  database: Db,
  vendorId: string,
  session: ClientSession,
): Promise<void> {
  // A per-vendor write inside the transaction serializes limit-sensitive changes across API instances.
  const result = await database.collection<VendorDocument>('user').updateOne(
    { _id: vendorId },
    { $inc: { serviceMutationVersion: 1 } },
    { session },
  );

  if (result.matchedCount !== 1) {
    throw new AppError('Vendor account is unavailable.', 403);
  }
}

async function withVendorTransaction<T>(
  database: Db,
  client: MongoClient,
  vendorId: string,
  operation: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = client.startSession();

  try {
    return await session.withTransaction(async () => {
      await lockVendorServiceChanges(database, vendorId, session);
      return operation(session);
    });
  } finally {
    await session.endSession();
  }
}

export function createService(
  database: Db,
  client: MongoClient,
  vendorId: string,
  input: CreateServiceInput,
): Promise<ServiceResponse> {
  return withVendorTransaction(database, client, vendorId, async (session) => {
    const plan = await assertVendorPlan(database, vendorId, session);
    const services = serviceCollection(database);

    if (plan === 'free') {
      const activeCount = await services.countDocuments(
        { vendorId, availability: true },
        { session },
      );

      if (activeCount >= FREE_ACTIVE_SERVICE_LIMIT) {
        throw new AppError(
          'The Free plan allows up to 3 active services. Upgrade or deactivate a service to continue.',
          409,
        );
      }
    }

    const now = new Date();
    const service: ServiceDocument = {
      _id: new ObjectId(),
      vendorId,
      ...input,
      status: 'Pending',
      availability: true,
      createdAt: now,
      updatedAt: now,
    };

    await services.insertOne(service, { session });
    return toServiceResponse(service);
  });
}

export async function getVendorServices(
  database: Db,
  vendorId: string,
): Promise<ServiceResponse[]> {
  const services = await serviceCollection(database)
    .find({ vendorId })
    .sort({ createdAt: -1 })
    .toArray();

  return services.map(toServiceResponse);
}

export async function updateVendorService(
  database: Db,
  vendorId: string,
  serviceId: string,
  input: UpdateServiceInput,
): Promise<ServiceResponse> {
  const now = new Date();
  const updated = await serviceCollection(database).findOneAndUpdate(
    { _id: parseServiceId(serviceId), vendorId },
    { $set: { ...input, updatedAt: now } },
    { returnDocument: 'after' },
  );

  if (!updated) {
    throw new AppError('Service not found.', 404);
  }

  return toServiceResponse(updated);
}

export async function deleteVendorService(
  database: Db,
  client: MongoClient,
  vendorId: string,
  serviceId: string,
): Promise<void> {
  const objectId = parseServiceId(serviceId);

  await withVendorTransaction(database, client, vendorId, async (session) => {
    const result = await serviceCollection(database).deleteOne(
      { _id: objectId, vendorId },
      { session },
    );

    if (result.deletedCount !== 1) {
      throw new AppError('Service not found.', 404);
    }
  });
}

export function updateVendorServiceAvailability(
  database: Db,
  client: MongoClient,
  vendorId: string,
  serviceId: string,
  availability: boolean,
): Promise<ServiceResponse> {
  const objectId = parseServiceId(serviceId);

  return withVendorTransaction(database, client, vendorId, async (session) => {
    const services = serviceCollection(database);
    const service = await services.findOne({ _id: objectId, vendorId }, { session });

    if (!service) {
      throw new AppError('Service not found.', 404);
    }

    if (availability && !service.availability) {
      const plan = await assertVendorPlan(database, vendorId, session);

      if (plan === 'free') {
        const activeCount = await services.countDocuments(
          { vendorId, availability: true },
          { session },
        );

        if (activeCount >= FREE_ACTIVE_SERVICE_LIMIT) {
          throw new AppError(
            'The Free plan allows up to 3 active services. Upgrade or deactivate a service to continue.',
            409,
          );
        }
      }
    }

    const updated = await services.findOneAndUpdate(
      { _id: objectId, vendorId },
      { $set: { availability, updatedAt: new Date() } },
      { returnDocument: 'after', session },
    );

    if (!updated) {
      throw new AppError('Service not found.', 404);
    }

    return toServiceResponse(updated);
  });
}

