import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { Db } from 'mongodb';
import type { StripeClient } from '../src/services/stripe.service.js';
import { createStripeWebhookRouter } from '../src/routes/webhook.routes.js';

type MockConstructEvent = (
  payload: string | Buffer,
  sig: string,
  secret: string,
) => { type: string };

const mockConstructEvent = (eventType: string): MockConstructEvent => {
  return (_payload, _sig, _secret) => {
    return { type: eventType };
  };
};

const throwingConstructEvent: MockConstructEvent = () => {
  throw new Error('Invalid signature');
};

function createMockStripeClient(
  constructEvent: MockConstructEvent,
): StripeClient {
  return {
    webhooks: {
      constructEvent,
    },
  } as unknown as StripeClient;
}

async function withWebhookServer<T>(
  options: {
    stripeClient?: StripeClient;
    webhookSecret?: string;
  },
  action: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(
    '/api/webhooks',
    createStripeWebhookRouter(
      undefined as unknown as Db,
      { stripeClient: options.stripeClient },
    ),
  );

  const server: Server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port.');
  }

  const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (options.webhookSecret !== undefined) {
    process.env.STRIPE_WEBHOOK_SECRET = options.webhookSecret;
  } else {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }

  try {
    return await action(`http://127.0.0.1:${address.port}`);
  } finally {
    if (originalSecret !== undefined) {
      process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
    } else {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('valid Stripe signature returns 200', async () => {
  const stripeClient = createMockStripeClient(mockConstructEvent('checkout.session.completed'));

  await withWebhookServer({ stripeClient, webhookSecret: 'whsec_test' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1234567890,v1=testsig',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'checkout.session.completed', data: {} }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
  });
});

test('recognized checkout.session.completed event returns 200', async () => {
  const stripeClient = createMockStripeClient(mockConstructEvent('checkout.session.completed'));

  await withWebhookServer({ stripeClient, webhookSecret: 'whsec_test' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1234567890,v1=testsig',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } }),
    });

    assert.equal(response.status, 200);
  });
});

test('unrecognized event type still returns 200', async () => {
  const stripeClient = createMockStripeClient(mockConstructEvent('invoice.payment_succeeded'));

  await withWebhookServer({ stripeClient, webhookSecret: 'whsec_test' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1234567890,v1=testsig',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'invoice.payment_succeeded', data: {} }),
    });

    assert.equal(response.status, 200);
  });
});

test('missing stripe-signature header returns 400', async () => {
  const stripeClient = createMockStripeClient(mockConstructEvent('checkout.session.completed'));

  await withWebhookServer({ stripeClient, webhookSecret: 'whsec_test' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'checkout.session.completed', data: {} }),
    });

    assert.equal(response.status, 400);
  });
});

test('invalid Stripe signature returns 400', async () => {
  const stripeClient = createMockStripeClient(throwingConstructEvent);

  await withWebhookServer({ stripeClient, webhookSecret: 'whsec_test' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1234567890,v1=badsig',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'checkout.session.completed', data: {} }),
    });

    assert.equal(response.status, 400);
  });
});

test('malformed payload returns 400', async () => {
  const stripeClient = createMockStripeClient(throwingConstructEvent);

  await withWebhookServer({ stripeClient, webhookSecret: 'whsec_test' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1234567890,v1=testsig',
        'content-type': 'application/json',
      },
      body: 'not-valid-json',
    });

    assert.equal(response.status, 400);
  });
});

test('missing webhook secret returns 500', async () => {
  const stripeClient = createMockStripeClient(mockConstructEvent('checkout.session.completed'));

  await withWebhookServer({ stripeClient }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1234567890,v1=testsig',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'checkout.session.completed', data: {} }),
    });

    assert.equal(response.status, 500);
  });
});
