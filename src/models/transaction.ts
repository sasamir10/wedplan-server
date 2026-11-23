import { ObjectId, type Document } from 'mongodb';

export interface TransactionDocument extends Document {
  _id: ObjectId;
  vendorId: ObjectId;
  stripeCheckoutSessionId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: Date;
}

export interface TransactionResponse {
  id: string;
  vendorId: string;
  stripeCheckoutSessionId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: Date;
}
