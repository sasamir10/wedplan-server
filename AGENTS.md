# WedPlan Server Development Guide

## Architecture

- `src/config` loads and validates process configuration.
- `src/middleware` contains shared Express middleware for errors and unknown routes.
- `src/routes` organizes REST endpoints by API area.
- `src/utils` contains reusable application primitives such as `AppError`.
- `src/app.ts` configures Express; `src/server.ts` starts the HTTP listener.

## TypeScript and ESM

- Write backend application logic in TypeScript under `src/`.
- Keep TypeScript strict and use NodeNext module semantics.
- Include `.js` extensions in relative imports so emitted ESM runs in Node.js.
- Prefer explicit types and avoid `any`.

## Middleware Responsibilities

- Configure cross-cutting middleware in `app.ts` in request-processing order.
- Route handlers should pass failures to Express with `next(error)` or throw in async handlers.
- `not-found.ts` converts unmatched paths into an application error.
- `error-handler.ts` is the final middleware and returns consistent JSON errors.

## API Organization

- Group endpoints into focused route modules and mount them beneath `/api`.
- Keep transport concerns in routes and shared error primitives in `utils`.
- Keep business logic out of the server initialization module.

## Security Principles

- Validate environment variables at startup and never commit secrets.
- Keep Helmet enabled, restrict CORS to configured client origins, and use bounded body parsers.
- Do not expose stack traces or internal error details to production clients.
- Validate and normalize untrusted request data before using it.

## Future Development Rules

- Add only dependencies needed by an approved feature or infrastructure phase.
- Add database, authentication, payment, and media integrations in their planned phases.
- Keep changes within this backend repository; the Next.js client is maintained separately.
- Run `npm run typecheck` and `npm run build` after TypeScript changes.
