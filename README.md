# WedPlan Server

Express 5 REST API foundation for the WedPlan wedding planning platform. The frontend is maintained in a separate Next.js application.

## Requirements

- Node.js 26 LTS
- npm

## Installation

```bash
npm install
Copy-Item .env.example .env
```

Edit `.env` as needed. `PORT` defaults to `5000`, `NODE_ENV` to `development`, and `CLIENT_URL` to `http://localhost:3000`.

## Run

```bash
npm run dev
```

The API starts on the configured port. The server-level health check is available at `GET http://localhost:5000/api/health`.

## Build and run compiled output

```bash
npm run typecheck
npm run build
npm start
```

`npm start` runs the compiled ESM output from `dist/`.
