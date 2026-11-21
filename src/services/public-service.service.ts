import type { Db, Document, Filter, ObjectId } from 'mongodb';
import type { PublicServiceQuery } from '../models/public-service.js';
import type { ServiceCategory } from '../models/service.js';
import { toBetterAuthUserObjectId } from '../utils/object-id.js';
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

  const vendorIds = [...new Set(serviceDocuments.map((service) => service.vendorId))];
  const vendorObjectIds = vendorIds
    .map((vendorId) => toBetterAuthUserObjectId(vendorId))
    .filter((vendorId): vendorId is ObjectId => vendorId !== null);
  const vendors = vendorObjectIds.length
    ? await database
        .collection<PublicVendorDocument>('user')
        .find({ _id: { $in: vendorObjectIds } })
        .project<PublicVendorDocument>({ name: 1, businessName: 1 })
        .toArray()
    : [];
  const vendorsById = new Map(
    vendors.map((vendor) => [vendor._id.toHexString(), vendor]),
  );

  return serviceDocuments.map((service) => {
    const vendor = vendorsById.get(service.vendorId);

    return {
      id: service._id.toHexString(),
      serviceName: service.serviceName,
      category: service.category,
      description: service.description,
      price: service.price,
      location: service.location,
      images: service.images,
      vendor: vendor
        ? {
            name: publicText(vendor.name),
            businessName: publicText(vendor.businessName),
          }
        : null,
      createdAt: service.createdAt,
    };
  });
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
