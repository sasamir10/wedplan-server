import { MongoClient, type Db } from 'mongodb';
import { env } from './env.js';

let client: MongoClient | null = null;
let database: Db | null = null;
let connectionPromise: Promise<Db> | null = null;

function redactSensitiveValues(message: string): string {
  let redactedMessage = message.replace(
    /mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi,
    '[REDACTED_MONGODB_URI]',
  );

  try {
    const parsedUri = new URL(env.MONGODB_URI);
    const credentials = [parsedUri.username, parsedUri.password]
      .flatMap((value) => {
        if (!value) {
          return [];
        }

        try {
          return [value, decodeURIComponent(value)];
        } catch {
          return [value];
        }
      })
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort((first, second) => second.length - first.length);

    for (const credential of credentials) {
      redactedMessage = redactedMessage.replaceAll(credential, '[REDACTED]');
    }
  } catch {
    // The configured URI is validated at startup; URI redaction above still applies.
  }

  return redactedMessage;
}

/** Formats the original MongoDB error without exposing connection credentials. */
export function getMongoErrorDiagnostics(error: unknown): {
  name: string;
  code?: string | number;
  message: string;
} {
  const errorRecord = typeof error === 'object' && error !== null ? error : undefined;
  const name =
    errorRecord && 'name' in errorRecord && typeof errorRecord.name === 'string'
      ? errorRecord.name
      : 'MongoDBError';
  const causeRecord =
    errorRecord && 'cause' in errorRecord && typeof errorRecord.cause === 'object' && errorRecord.cause !== null
      ? errorRecord.cause
      : undefined;
  const directCode = errorRecord && 'code' in errorRecord ? errorRecord.code : undefined;
  const causeCode = causeRecord && 'code' in causeRecord ? causeRecord.code : undefined;
  const code = [directCode, causeCode].find(
    (value): value is string | number => typeof value === 'string' || typeof value === 'number',
  );
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'An unknown MongoDB error occurred.';

  return {
    name: redactSensitiveValues(name),
    ...(code === undefined
      ? {}
      : { code: typeof code === 'string' ? redactSensitiveValues(code) : code }),
    message: redactSensitiveValues(message),
  };
}

/**
 * Creates the idempotent indexes required by the `webhook-events` collection.
 *
 * The unique index on `stripeEventId` prevents the same Stripe webhook event
 * from being processed more than once. Index creation is idempotent: repeating
 * it with the same name and specification is a no-op.
 */
export async function ensureWebhookIndexes(database: Db): Promise<void> {
  const webhookEvents = database.collection('webhook-events');
  await webhookEvents.createIndexes([
    {
      key: { stripeEventId: 1 },
      name: 'idx_webhook_events_stripe_event_id_unique',
      unique: true,
    },
    {
      key: { status: 1, createdAt: -1 },
      name: 'idx_webhook_events_status_created_at',
    },
  ]);

  const transactions = database.collection('transactions');

  // Migration: if a pre-existing full unique index with the same name exists
  // (without partialFilterExpression), drop it first. MongoDB rejects
  // createIndexes when the same index name has different options
  // (IndexOptionsConflict). Dropping then recreating is safe: no documents
  // are deleted, and duplicate non-empty string Checkout Session IDs are
  // checked before the new index is created.
  const existingIndexes = await (await transactions.listIndexes()).toArray();
  const outdatedIndex = existingIndexes.find(
    (index) =>
      index.name === 'idx_transactions_stripe_checkout_session_id_unique' &&
      !index.partialFilterExpression,
  );

  if (outdatedIndex) {
    await transactions.dropIndex('idx_transactions_stripe_checkout_session_id_unique');
  }

  // Verify no duplicate non-empty string Checkout Session IDs exist before
  // creating the partial unique index. If duplicates exist, fail safely
  // with a clear server-side error — do not delete or modify documents.
  const duplicateSessions = await (await transactions
    .aggregate([
      {
        $match: {
          stripeCheckoutSessionId: { $type: 'string', $ne: '' },
        },
      },
      {
        $group: {
          _id: '$stripeCheckoutSessionId',
          count: { $sum: 1 },
        },
      },
      {
        $match: { count: { $gt: 1 } },
      },
    ])
    ).toArray();

  if (duplicateSessions.length > 0) {
    throw new Error(
      `Cannot create unique index on transactions.stripeCheckoutSessionId: ` +
      `${duplicateSessions.length} duplicate Checkout Session ID(s) found. ` +
      `Resolve duplicates before deploying this migration.`,
    );
  }

  await transactions.createIndexes([
    {
      key: { stripeCheckoutSessionId: 1 },
      name: 'idx_transactions_stripe_checkout_session_id_unique',
      unique: true,
      partialFilterExpression: { stripeCheckoutSessionId: { $type: 'string' } },
    },
  ]);
}

/**
 * Creates the idempotent indexes required by the `bookings` collection.
 *
 * Index creation is idempotent: repeating it with the same name and
 * specification is a no-op. An incompatible pre-existing index (for example,
 * the same name with a different specification) causes MongoDB to reject the
 * operation, which surfaces as a clear startup failure rather than a
 * destructive migration.
 */
export async function ensureBookingIndexes(database: Db): Promise<void> {
  const bookings = database.collection('bookings');
  await bookings.createIndexes([
    {
      key: { customerId: 1, status: 1 },
      name: 'idx_bookings_customer_status',
    },
    {
      key: { vendorId: 1, status: 1 },
      name: 'idx_bookings_vendor_status',
    },
    {
      key: { serviceId: 1, eventDate: 1 },
      name: 'idx_bookings_service_date_unique_active',
      unique: true,
      partialFilterExpression: { status: { $in: ['Pending', 'Accepted'] } },
    },
    {
      key: { createdAt: -1 },
      name: 'idx_bookings_created_at_desc',
    },
  ]);
}

/** Opens the MongoDB connection once and verifies it with a ping. */
export function connectToDatabase(): Promise<Db> {
  if (database) {
    return Promise.resolve(database);
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  let mongoClient: MongoClient;
  try {
    mongoClient = new MongoClient(env.MONGODB_URI);
  } catch (error) {
    return Promise.reject(
      new Error('MongoDB connection failed. Check MONGODB_URI and database network access.', {
        cause: error,
      }),
    );
  }

  client = mongoClient;
  connectionPromise = (async () => {
    try {
      await mongoClient.connect();
      const connectedDatabase = mongoClient.db(env.MONGODB_DB_NAME);
      await connectedDatabase.command({ ping: 1 });

      await ensureBookingIndexes(connectedDatabase);
      await ensureWebhookIndexes(connectedDatabase);

      database = connectedDatabase;
      console.info('MongoDB connection established.');
      return connectedDatabase;
    } catch (error) {
      await mongoClient.close().catch(() => undefined);
      if (client === mongoClient) {
        client = null;
      }

      throw new Error(
        'MongoDB connection failed. Check MONGODB_URI, MONGODB_DB_NAME, and database network access.',
        { cause: error },
      );
    } finally {
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

/** Returns the active database, or throws if connection has not succeeded. */
export function getDatabase(): Db {
  if (!database) {
    throw new Error('MongoDB is not connected. Call connectToDatabase() first.');
  }

  return database;
}

/** Returns the active MongoDB client, or throws if connection has not succeeded. */
export function getMongoClient(): MongoClient {
  if (!client || !database) {
    throw new Error('MongoDB is not connected. Call connectToDatabase() first.');
  }

  return client;
}

/** Closes the active MongoDB client, if one exists. */
export async function closeDatabaseConnection(): Promise<void> {
  const pendingConnection = connectionPromise;
  if (pendingConnection) {
    await pendingConnection.catch(() => undefined);
  }

  const activeClient = client;
  client = null;
  database = null;

  if (activeClient) {
    await activeClient.close();
  }
}
