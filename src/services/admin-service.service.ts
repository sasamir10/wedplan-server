import {
  ObjectId,
  type Collection,
  type Db,
  type Document,
  type Filter,
} from 'mongodb';
import type { AdminServiceQuery } from '../models/admin-service.js';
import type { ServiceCategory, ServiceStatus } from '../models/service.js';
import { AppError } from '../utils/app-error.js';
import type { ServiceDocument } from './service.service.js';

interface AdminVendorDocument extends Document {
  _id: string;
  name?: string;
  businessName?: string;
}

export interface AdminVendorSummary {
  id: string;
  name: string | null;
  businessName: string | null;
}

export interface AdminServiceResponse {
  id: string;
  vendorId: string;
  vendor: AdminVendorSummary | null;
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

export interface AdminServicePage {
  services: AdminServiceResponse[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

function serviceCollection(database: Db): Collection<ServiceDocument> {
  return database.collection<ServiceDocument>('services');
}

function parseServiceId(value: string): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new AppError('Invalid service ID.', 400);
  }

  return new ObjectId(value);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toAdminServiceResponse(
  service: ServiceDocument,
  vendor: AdminVendorDocument | undefined,
): AdminServiceResponse {
  return {
    id: service._id.toHexString(),
    vendorId: service.vendorId,
    vendor: vendor
      ? {
          id: vendor._id,
          name: typeof vendor.name === 'string' ? vendor.name : null,
          businessName:
            typeof vendor.businessName === 'string' ? vendor.businessName : null,
        }
      : null,
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

export async function listAdminServices(
  database: Db,
  query: AdminServiceQuery,
): Promise<AdminServicePage> {
  const filter: Filter<ServiceDocument> = {};
  if (query.status) filter.status = query.status;
  if (query.category) filter.category = query.category;
  if (query.availability !== undefined) filter.availability = query.availability;
  if (query.search) {
    filter.serviceName = {
      $regex: escapeRegularExpression(query.search),
      $options: 'i',
    };
  }

  const servicesCollection = serviceCollection(database);
  const [total, services] = await Promise.all([
    servicesCollection.countDocuments(filter),
    servicesCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .toArray(),
  ]);

  const vendorIds = [...new Set(services.map((service) => service.vendorId))];
  const vendors: AdminVendorDocument[] = vendorIds.length
    ? await database
        .collection<AdminVendorDocument>('user')
        .find({ _id: { $in: vendorIds } })
        .project<AdminVendorDocument>({ name: 1, businessName: 1 })
        .toArray()
    : [];
  const vendorsById = new Map(vendors.map((vendor) => [vendor._id, vendor]));

  return {
    services: services.map((service) =>
      toAdminServiceResponse(service, vendorsById.get(service.vendorId)),
    ),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

export async function approvePendingService(
  database: Db,
  serviceId: string,
): Promise<AdminServiceResponse> {
  return updatePendingServiceStatus(database, serviceId, 'Approved');
}

export async function rejectPendingService(
  database: Db,
  serviceId: string,
): Promise<AdminServiceResponse> {
  return updatePendingServiceStatus(database, serviceId, 'Rejected');
}

async function updatePendingServiceStatus(
  database: Db,
  serviceId: string,
  status: Exclude<ServiceStatus, 'Pending'>,
): Promise<AdminServiceResponse> {
  const id = parseServiceId(serviceId);
  const updated = await serviceCollection(database).findOneAndUpdate(
    { _id: id, status: 'Pending' },
    { $set: { status, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );

  if (!updated) {
    await assertServiceExists(database, id);
    throw new AppError('Only pending services can be approved or rejected.', 409);
  }

  const vendor = await database
    .collection<AdminVendorDocument>('user')
    .findOne({ _id: updated.vendorId }, { projection: { name: 1, businessName: 1 } });

  return toAdminServiceResponse(updated, vendor ?? undefined);
}

export async function updateAdminServiceStatus(
  database: Db,
  serviceId: string,
  status: ServiceStatus,
): Promise<AdminServiceResponse> {
  const id = parseServiceId(serviceId);
  const updated = await serviceCollection(database).findOneAndUpdate(
    { _id: id, status: { $ne: status } },
    { $set: { status, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );

  if (!updated) {
    const existing = await serviceCollection(database).findOne({ _id: id });
    if (!existing) throw new AppError('Service not found.', 404);
    throw new AppError('Service already has the requested status.', 409);
  }

  const vendor = await database
    .collection<AdminVendorDocument>('user')
    .findOne({ _id: updated.vendorId }, { projection: { name: 1, businessName: 1 } });

  return toAdminServiceResponse(updated, vendor ?? undefined);
}

async function assertServiceExists(database: Db, id: ObjectId): Promise<void> {
  const service = await serviceCollection(database).findOne({ _id: id });
  if (!service) throw new AppError('Service not found.', 404);
}

export async function deleteAdminService(
  database: Db,
  serviceId: string,
): Promise<void> {
  const result = await serviceCollection(database).deleteOne({
    _id: parseServiceId(serviceId),
  });

  if (result.deletedCount !== 1) {
    throw new AppError('Service not found.', 404);
  }
}
