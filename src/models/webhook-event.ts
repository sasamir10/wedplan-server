import { ObjectId, type Document } from 'mongodb';

export type WebhookEventStatus = 'pending' | 'completed' | 'failed';

export interface WebhookEventDocument extends Document {
  _id: ObjectId;
  stripeEventId: string;
  eventType: string;
  status: WebhookEventStatus;
  checkoutSessionId?: string;
  vendorId?: ObjectId;
  errorMessage?: string;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookEventResponse {
  id: string;
  stripeEventId: string;
  eventType: string;
  status: WebhookEventStatus;
  checkoutSessionId?: string;
  vendorId?: string;
  errorMessage?: string;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
