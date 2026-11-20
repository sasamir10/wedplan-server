import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APIError } from 'better-auth/api';
import {
  assertUserCanCreateSession,
  beforeUserCreate,
  beforeUserUpdate,
  validateSignupPassword,
} from '../src/config/auth-hooks.js';

const emailSignupContext = { path: '/sign-up/email' };

test('assigns customer role and removes signupRole before persistence', async () => {
  const result = await beforeUserCreate(
    {
      name: 'Customer',
      signupRole: 'customer',
      isBlocked: false,
      subscriptionPlan: 'free',
    },
    emailSignupContext,
  );

  assert.equal(result.data.role, 'customer');
  assert.equal('signupRole' in result.data, false);
  assert.equal(result.data.isBlocked, false);
  assert.equal(result.data.subscriptionPlan, 'free');
});

test('assigns vendor role and removes signupRole before persistence', async () => {
  const result = await beforeUserCreate(
    {
      name: 'Vendor',
      signupRole: 'vendor',
      signupBusinessName: 'Ever After Events',
    },
    emailSignupContext,
  );

  assert.equal(result.data.role, 'vendor');
  assert.equal(result.data.businessName, 'Ever After Events');
  assert.equal('signupRole' in result.data, false);
  assert.equal('signupBusinessName' in result.data, false);
});

test('rejects admin role injection during public email signup', async () => {
  await assert.rejects(
    () =>
      beforeUserCreate(
        { name: 'Injected admin', signupRole: 'customer', role: 'admin' },
        emailSignupContext,
      ),
    (error: unknown) => error instanceof APIError && error.status === 'FORBIDDEN',
  );
});

test('rejects invalid or missing signupRole during public email signup', async () => {
  for (const signupRole of ['admin', undefined]) {
    await assert.rejects(
      () => beforeUserCreate({ name: 'Invalid role', signupRole }, emailSignupContext),
      (error: unknown) => error instanceof APIError && error.status === 'BAD_REQUEST',
    );
  }
});

test('rejects role changes through user update endpoints', async () => {
  await assert.rejects(
    () => beforeUserUpdate({ role: 'admin' }),
    (error: unknown) => error instanceof APIError && error.status === 'FORBIDDEN',
  );
});

test('allows unrelated user updates', async () => {
  await assert.doesNotReject(() => beforeUserUpdate({ name: 'Updated name' }));
});

test('does not require signupRole for a future non-email auth flow', async () => {
  const result = await beforeUserCreate(
    { name: 'OAuth user', role: 'customer', signupRole: undefined },
    { path: '/callback/google' },
  );

  assert.equal(result.data.role, 'customer');
  assert.equal('signupRole' in result.data, false);
});

test('accepts signup passwords matching the frontend complexity rules', () => {
  assert.doesNotThrow(() => validateSignupPassword('WedPlanPassword8'));
});

test('rejects signup passwords missing uppercase or lowercase letters', () => {
  for (const password of ['wedplanpassword8', 'WEDPLANPASSWORD8', undefined]) {
    assert.throws(
      () => validateSignupPassword(password),
      (error: unknown) => error instanceof APIError && error.status === 'BAD_REQUEST',
    );
  }
});

test('prevents blocked users from creating a new session', () => {
  assert.throws(
    () => assertUserCanCreateSession(true),
    (error: unknown) => error instanceof APIError && error.status === 'FORBIDDEN',
  );
});

test('allows unblocked users to create a new session', () => {
  assert.doesNotThrow(() => assertUserCanCreateSession(false));
});
