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
import { parseObjectId, toBetterAuthUserObjectId } from '../utils/object-id.js';
import type { ServiceDocument } from './service.service.js';

interface AdminVendorDocument extends Document {
  _id: ObjectId;
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
  return parseObjectId(value, 'service');
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
          id: vendor._id.toHexString(),
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
  const vendorObjectIds = vendorIds
    .map((vendorId) => toBetterAuthUserObjectId(vendorId))
    .filter((vendorId): vendorId is ObjectId => vendorId !== null);
  const vendors: AdminVendorDocument[] = vendorObjectIds.length
    ? await database
        .collection<AdminVendorDocument>('user')
        .find({ _id: { $in: vendorObjectIds } })
        .project<AdminVendorDocument>({ name: 1, businessName: 1 })
        .toArray()
    : [];
  const vendorsById = new Map(
    vendors.map((vendor) => [vendor._id.toHexString(), vendor]),
  );

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
    throw new AppError(
      'Only pending services can be approved or rejected.',
      409,
      true,
      'INVALID_SERVICE_STATUS',
    );
  }

  const vendor = await findVendorDisplay(database, updated.vendorId);

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
    if (!existing) throw new AppError('Service not found.', 404, true, 'SERVICE_NOT_FOUND');
    throw new AppError(
      'Service already has the requested status.',
      409,
      true,
      'INVALID_SERVICE_STATUS',
    );
  }

  const vendor = await findVendorDisplay(database, updated.vendorId);

  return toAdminServiceResponse(updated, vendor ?? undefined);
}

async function findVendorDisplay(
  database: Db,
  vendorId: string,
): Promise<AdminVendorDocument | null> {
  const vendorObjectId = toBetterAuthUserObjectId(vendorId);

  if (!vendorObjectId) return null;

  return database
    .collection<AdminVendorDocument>('user')
    .findOne(
      { _id: vendorObjectId },
      { projection: { name: 1, businessName: 1 } },
    );
}

async function assertServiceExists(database: Db, id: ObjectId): Promise<void> {
  const service = await serviceCollection(database).findOne({ _id: id });
  if (!service) throw new AppError('Service not found.', 404, true, 'SERVICE_NOT_FOUND');
}

export async function deleteAdminService(
  database: Db,
  serviceId: string,
): Promise<void> {
  const result = await serviceCollection(database).deleteOne({
    _id: parseServiceId(serviceId),
  });

  if (result.deletedCount !== 1) {
    throw new AppError('Service not found.', 404, true, 'SERVICE_NOT_FOUND');
  }
}
