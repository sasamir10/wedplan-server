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

Edit `.env` and provide `MONGODB_URI` and `MONGODB_DB_NAME`. The URI must use `mongodb://` or `mongodb+srv://`; keep credentials private. `PORT` defaults to `5000`, `NODE_ENV` to `development`, and `CLIENT_URL` to `http://localhost:3000`.

## Run

```bash
npm run dev
```

The API connects to MongoDB and verifies the connection before it starts listening on the configured port. The server-level health check is available at `GET http://localhost:5000/api/health`. `Ctrl+C` and termination signals close the HTTP server and MongoDB connection gracefully.

The shared connection helpers are in `src/config/database.ts`: `connectToDatabase()` establishes and verifies the connection, `getDatabase()` returns the active database, and `closeDatabaseConnection()` closes it. No collections are created during startup.

## Build and run compiled output

```bash
npm run typecheck
npm run build
npm start
```

`npm start` runs the compiled ESM output from `dist/`.
