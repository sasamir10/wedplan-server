import type { Db, Document, Filter, ObjectId } from 'mongodb';
import type { PublicServiceQuery } from '../models/public-service.js';
import type { ServiceCategory } from '../models/service.js';
import { AppError } from '../utils/app-error.js';
import { parseObjectId, toBetterAuthUserObjectId } from '../utils/object-id.js';
import type { ServiceDocument } from './service.service.js';

interface PublicVendorDocument extends Document {
  _id: ObjectId;
  name?: unknown;
  businessName?: unknown;
}

interface PublicServiceDocument extends Document {
  _id: ServiceDocument['_id'];
  vendorId: string;
  serviceName: string;
  category: ServiceCategory;
  description: string;
  price: number;
  location: string;
  images: string[];
  createdAt: Date;
}

export interface PublicVendorSummary {
  name: string | null;
  businessName: string | null;
}

export interface PublicServiceResponse {
  id: string;
  serviceName: string;
  category: ServiceCategory;
  description: string;
  price: number;
  location: string;
  images: string[];
  vendor: PublicVendorSummary | null;
  createdAt: Date;
}

/**
 * A single public service adds viewer context so the client can prevent a
 * vendor from booking their own listing without exposing the vendor ID.
 */
export interface PublicServiceDetailResponse extends PublicServiceResponse {
  isOwner: boolean;
}

const publicServiceFilter: Filter<ServiceDocument> = {
  status: 'Approved',
  availability: true,
};

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function publicText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function toPublicServiceResponse(
  service: PublicServiceDocument,
  vendor: PublicVendorSummary | null,
): PublicServiceResponse {
  return {
    id: service._id.toHexString(),
    serviceName: service.serviceName,
    category: service.category,
    description: service.description,
    price: service.price,
    location: service.location,
    images: service.images,
    vendor,
    createdAt: service.createdAt,
  };
}

async function readPublicVendors(
  database: Db,
  vendorIds: string[],
): Promise<Map<string, PublicVendorSummary>> {
  const vendorObjectIds = [...new Set(vendorIds)]
    .map((vendorId) => toBetterAuthUserObjectId(vendorId))
    .filter((vendorId): vendorId is ObjectId => vendorId !== null);

  if (vendorObjectIds.length === 0) {
    return new Map();
  }

  const vendors = await database
    .collection<PublicVendorDocument>('user')
    .find({ _id: { $in: vendorObjectIds } })
    .project<PublicVendorDocument>({ name: 1, businessName: 1 })
    .toArray();

  return new Map(
    vendors.map((vendor) => [
      vendor._id.toHexString(),
      {
        name: publicText(vendor.name),
        businessName: publicText(vendor.businessName),
      },
    ]),
  );
}

async function readPublicServices(
  database: Db,
  query: PublicServiceQuery = {},
  limit?: number,
): Promise<PublicServiceResponse[]> {
  const filter: Filter<ServiceDocument> = { ...publicServiceFilter };

  if (query.search) {
    filter.serviceName = {
      $regex: escapeRegularExpression(query.search),
      $options: 'i',
    };
  }
  if (query.category) {
    filter.category = query.category;
  }
  if (query.location) {
    filter.location = {
      $regex: escapeRegularExpression(query.location),
      $options: 'i',
    };
  }

  const serviceCursor = database
    .collection<ServiceDocument>('services')
    .find(filter)
    .project<PublicServiceDocument>({
      _id: 1,
      vendorId: 1,
      serviceName: 1,
      category: 1,
      description: 1,
      price: 1,
      location: 1,
      images: 1,
      createdAt: 1,
    });

  if (query.sort === 'price-asc') {
    serviceCursor.sort({ price: 1, createdAt: -1, _id: -1 });
  } else if (query.sort === 'price-desc') {
    serviceCursor.sort({ price: -1, createdAt: -1, _id: -1 });
  } else {
    serviceCursor.sort({ createdAt: -1, _id: -1 });
  }

  const serviceDocuments = limit === undefined
    ? await serviceCursor.toArray()
    : await serviceCursor.limit(limit).toArray();

  if (serviceDocuments.length === 0) {
    return [];
  }

  const vendorsById = await readPublicVendors(
    database,
    serviceDocuments.map((service) => service.vendorId),
  );

  return serviceDocuments.map((service) =>
    toPublicServiceResponse(service, vendorsById.get(service.vendorId) ?? null),
  );
}

/** Lists approved, active services with only the vendor display fields needed publicly. */
export function listPublicServices(
  database: Db,
  query: PublicServiceQuery = {},
): Promise<PublicServiceResponse[]> {
  return readPublicServices(database, query);
}

/** Lists up to six approved, active services, newest first with an ID tie-breaker. */
export function listFeaturedPublicServices(database: Db): Promise<PublicServiceResponse[]> {
  return readPublicServices(database, {}, 6);
}

/**
 * Reads one approved, active service for an authenticated viewer.
 *
 * Invalid, missing, unpublished, and inactive services all return the same 404
 * so the endpoint never reveals whether an unpublished listing exists.
 */
export async function getPublicServiceById(
  database: Db,
  serviceId: string,
  viewerId: string,
): Promise<PublicServiceDetailResponse> {
  let objectId: ObjectId;

  try {
    objectId = parseObjectId(serviceId, 'service');
  } catch {
    throw new AppError('Service not found.', 404, true, 'SERVICE_NOT_FOUND');
  }

  const service = await database
    .collection<ServiceDocument>('services')
    .findOne({ _id: objectId, ...publicServiceFilter });

  if (!service) {
    throw new AppError('Service not found.', 404, true, 'SERVICE_NOT_FOUND');
  }

  const vendorsById = await readPublicVendors(database, [service.vendorId]);

  return {
    ...toPublicServiceResponse(service, vendorsById.get(service.vendorId) ?? null),
    isOwner: service.vendorId === viewerId,
  };
}
