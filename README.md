# WedPlan Server

The backend API for **WedPlan**, a wedding planning platform built with Express 5 and TypeScript. It provides authentication, role-based access control, wedding service management, booking workflows, profile management, dashboards, and admin operations through a REST API backed by MongoDB Atlas.

**Live API:** [WedPlan Server](https://wedplan-server-0m17.onrender.com)

**Live Application:** [WedPlan](https://yourwed-plan.vercel.app/)

**Client Repository:** [wedplan-client](https://github.com/sasamir10/wedplan-client)

**Server Repository:** [wedplan-server](https://github.com/sasamir10/wedplan-server)

## Features

- **Authentication:** Email/password authentication powered by Better Auth, with session handling and JWT-based API authentication.
- **Role-Based Authorization:** Separate Customer, Vendor, and Admin roles with protected API routes.
- **Public Service Discovery:** Retrieve approved and active wedding services, including featured services and service details.
- **Vendor Service Management:** Create, update, activate, deactivate, and manage wedding service listings.
- **Service Moderation:** Admins can review submitted services and approve or reject them before public listing.
- **Free Plan Service Limit:** Free vendors can have up to three active services; Premium vendors are designed for unlimited active services.
- **Booking Management:** Customers can submit booking requests and manage their bookings; vendors can review, accept, or reject requests.
- **Booking Cancellation:** Customers can cancel eligible pending booking requests.
- **Customer Dashboard:** Provides booking statistics for total, pending, accepted, and rejected requests.
- **Vendor Dashboard:** Provides service and booking statistics alongside the vendor's subscription plan.
- **Admin Dashboard:** Provides platform statistics, including user, vendor, customer, service, pending-service, and transaction counts.
- **User Management:** Admins can search and filter users, view user details, and block or unblock accounts.
- **Profile Management:** Customers and vendors can update their name and profile image.
- **Image Uploads:** Profile and service images are uploaded through ImgBB integration.
- **Live Block-Status Checks:** Protected requests check the current database block status so an account blocked after token issuance cannot continue using protected features.
- **Request Validation:** Request payloads are validated with Zod.
- **MongoDB Native Driver:** Data access uses the official MongoDB Node.js driver without Mongoose.

## Tech Stack

- **Runtime:** Node.js
- **Language:** TypeScript
- **Backend Framework:** Express 5
- **Database:** MongoDB Atlas
- **Database Access:** MongoDB Native Node.js Driver
- **Authentication:** Better Auth
- **API Authorization:** JWT verification using JWKS and EdDSA
- **Validation:** Zod
- **Image Hosting:** ImgBB
- **Deployment:** Render
- **Development Tools:** npm, Git, GitHub

## Getting Started

### Prerequisites

- Node.js (use a currently supported LTS release)
- npm
- A MongoDB Atlas cluster and database
- An ImgBB API key for image uploads

### Installation

Clone the repository and navigate to the server directory:

```bash
git clone https://github.com/sasamir10/wedplan-server.git
cd wedplan-server
```

Install dependencies:

```bash
npm install
```

### Environment Variables

Create a `.env` file in the server root directory. Configure the following variables:

```env
PORT=5000
NODE_ENV=development
CLIENT_URL=http://localhost:3000

MONGODB_URI=your_mongodb_atlas_connection_string
MONGODB_DB_NAME=your_database_name

BETTER_AUTH_SECRET=your_better_auth_secret
BETTER_AUTH_URL=http://localhost:5000

IMGBB_API_KEY=your_imgbb_api_key
```

Replace the placeholder values with your own credentials. Never commit `.env` files or expose database connection strings, authentication secrets, or API keys.

For production deployment, configure the environment variables in the hosting provider instead of committing them to the repository. Use the deployed frontend URL for `CLIENT_URL` and the deployed backend URL for `BETTER_AUTH_URL`.

### Run Locally

Start the development server:

```bash
npm run dev
```

The API runs at:

```text
http://localhost:5000
```

The frontend is maintained in a separate repository and normally runs at `http://localhost:3000`.

### Production Build

Compile the TypeScript application:

```bash
npm run build
```

Start the compiled server:

```bash
npm start
```

## Project Structure

The server is organized around configuration, routes, middleware, services, utilities, and tests.

```text
wedplan-server/
├── src/
│   ├── config/
│   │   ├── auth.ts
│   │   └── env.ts
│   ├── middleware/
│   │   ├── authentication and authorization middleware
│   │   └── block-status.ts
│   ├── models/
│   ├── routes/
│   │   ├── customer routes
│   │   ├── vendor routes
│   │   ├── admin routes
│   │   ├── profile routes
│   │   └── public service routes
│   ├── services/
│   │   ├── booking services
│   │   ├── service management
│   │   ├── dashboard services
│   │   ├── profile services
│   │   └── admin user services
│   ├── utils/
│   │   └── object-id.ts
│   ├── app.ts
│   └── server.ts
├── tests/
├── .env.example
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
```

## Architecture & Security

### Authentication Flow

Better Auth handles registration, sign-in, session creation, and sign-out. Protected API requests are authenticated by verifying the JWT using the configured JWKS. The authenticated user's ID and role are obtained from the verified token, not from client-supplied identity fields.

### Roles and Access Control

| Role       | Main permissions                                                                            |
| ---------- | ------------------------------------------------------------------------------------------- |
| `customer` | Browse services, submit booking requests, view and cancel eligible bookings, manage profile |
| `vendor`   | Manage own services, review booking requests, view vendor dashboard, manage profile         |
| `admin`    | Manage users, moderate services, and view platform dashboard                                |

Admin accounts are not created through public signup. Admin access must be provisioned through a controlled administrative process.

### Important Security Rules

- Never trust client-supplied user IDs, vendor IDs, or role values for authorization.
- Derive the current user's identity from the verified authentication context.
- Service ownership is checked on the server before vendor operations are allowed.
- New vendor services start as **Pending** and active; public listings expose only approved and active services.
- Free vendor service limits are enforced by the backend, not only by the frontend.
- Blocked users are denied access to protected routes using a live database status check.
- Webhook-based subscription activation and Stripe payment processing have not been implemented yet; subscription/payment functionality remains deferred.

## API Endpoints

All application API endpoints are served from the backend base URL. Authentication endpoints are managed by Better Auth under `/api/auth/*`.

### Authentication

| Method      | Endpoint      | Description                                                                                        |
| ----------- | ------------- | -------------------------------------------------------------------------------------------------- |
| Better Auth | `/api/auth/*` | Registration, sign-in, session retrieval, sign-out, and other configured authentication operations |

### Public Services

| Method | Endpoint                 | Description                                                                 |
| ------ | ------------------------ | --------------------------------------------------------------------------- |
| `GET`  | `/api/services`          | Retrieve publicly available approved and active services                    |
| `GET`  | `/api/services/featured` | Retrieve featured services                                                  |
| `GET`  | `/api/services/:id`      | Retrieve service details for an authenticated user, subject to access rules |

### Customer Bookings

| Method  | Endpoint                            | Description                                    |
| ------- | ----------------------------------- | ---------------------------------------------- |
| `POST`  | `/api/customer/bookings`            | Submit a booking request                       |
| `GET`   | `/api/customer/bookings`            | Retrieve the authenticated customer's bookings |
| `PATCH` | `/api/customer/bookings/:id/cancel` | Cancel an eligible pending booking             |

### Vendor Bookings

| Method  | Endpoint                          | Description                                            |
| ------- | --------------------------------- | ------------------------------------------------------ |
| `GET`   | `/api/vendor/bookings`            | Retrieve booking requests for the authenticated vendor |
| `PATCH` | `/api/vendor/bookings/:id/accept` | Accept a pending booking request                       |
| `PATCH` | `/api/vendor/bookings/:id/reject` | Reject a pending booking request                       |

### Dashboards

| Method | Endpoint                        | Description                                    |
| ------ | ------------------------------- | ---------------------------------------------- |
| `GET`  | `/api/customer/dashboard/stats` | Retrieve customer booking statistics           |
| `GET`  | `/api/vendor/dashboard/stats`   | Retrieve vendor service and booking statistics |
| `GET`  | `/api/admin/dashboard/stats`    | Retrieve platform-wide dashboard statistics    |

### Profile

| Method  | Endpoint                    | Description                               |
| ------- | --------------------------- | ----------------------------------------- |
| `GET`   | `/api/profile`              | Retrieve the authenticated user's profile |
| `PATCH` | `/api/profile`              | Update permitted profile fields           |
| `POST`  | `/api/profile/upload-image` | Upload a profile image through ImgBB      |

### Admin User Management

| Method  | Endpoint                       | Description                                             |
| ------- | ------------------------------ | ------------------------------------------------------- |
| `GET`   | `/api/admin/users`             | Retrieve users with search, role filter, and pagination |
| `GET`   | `/api/admin/users/:id`         | Retrieve a user's details                               |
| `PATCH` | `/api/admin/users/:id/block`   | Block a user                                            |
| `PATCH` | `/api/admin/users/:id/unblock` | Unblock a user                                          |

Vendor service management and admin service moderation are also provided through their respective protected route groups.

## Booking Rules

- Only approved and active services can receive booking requests.
- Customers cannot book their own services.
- Admin accounts cannot submit customer bookings.
- A customer cannot create another active booking for the same service and event date while a pending or accepted booking already exists.
- Vendors can accept or reject pending requests for services they own.
- Customers can cancel their own pending bookings.
- Terminal booking states cannot be transitioned again.
- Booking records retain a service snapshot for historical display if the original service is later removed.

## Subscription Plans

The application currently supports the subscription plan fields and Free-plan service-limit enforcement.

- **Free:** Up to three active services.
- **Premium:** Intended to allow unlimited active services.

Stripe Checkout, verified payment webhooks, transaction processing, and automated Premium activation/expiration are deferred and are not currently available.

## Deployment

The backend is deployed on Render:

```text
https://wedplan-server-0m17.onrender.com
```

For a production deployment:

1. Connect the `wedplan-server` GitHub repository to a Render Web Service.
2. Set the root directory to the repository root.
3. Configure the build command:

    ```bash
    npm install --include=dev && npm run build
    ```

4. Configure the start command:

    ```bash
    npm start
    ```

5. Add the required production environment variables in Render.
6. Set `NODE_ENV=production`, `CLIENT_URL` to the deployed frontend origin, and `BETTER_AUTH_URL` to the deployed backend URL.
7. Deploy and inspect the service logs to confirm that the server starts and MongoDB connects successfully.

The frontend is deployed separately on Vercel. Configure its `NEXT_PUBLIC_API_BASE_URL` to point to the deployed backend.

## Testing & Verification

Run the available project checks from the server directory:

```bash
npm run build
npm test
```

The project has previously passed its server test suite with **248 tests passing**. Re-run the checks after making changes to verify the current code.

## Acknowledgements & Contributions

WedPlan is developed as a full-stack wedding planning platform. The backend provides the API, authentication, authorization, database operations, booking workflows, image upload integration, and administrative functionality consumed by the separate Next.js client application.

## Author

**Sabbir Ahmed Samir**

- GitHub: [@sasamir10](https://github.com/sasamir10)
- LinkedIn: [Sabbir Ahmed Samir](https://linkedin.com/in/sabbirahmed10)
