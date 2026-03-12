# DocuSign Integration Layer

A Node.js/Express application that serves as an integration layer between internal workflows and the DocuSign eSignature platform. This service handles document submission, webhook processing, data extraction, and downstream API integration.

## Features

- **Document Submission**: Submit documents to DocuSign for signature using pre-configured templates
- **Webhook Processing**: Receive and validate DocuSign Connect webhook callbacks
- **Data Extraction**: Extract signed document data and map to canonical format
- **Downstream Integration**: Push extracted data to external REST APIs with retry logic
- **Error Alerting**: Email notifications for failures with rate limiting
- **Monitoring Dashboard**: Web-based status dashboard with filtering and KPIs

## Prerequisites

- Node.js 18.x or higher
- npm 9.x or higher
- DocuSign Developer Account (Sandbox)
- Supabase account (free tier works)
- SMTP server for email alerts

## Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd docusign-layer
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Application
NODE_ENV=development
PORT=3000
API_KEY=your-secure-api-key-here

# DocuSign (from DocuSign Developer Console)
DOCUSIGN_ACCOUNT_ID=your-account-id
DOCUSIGN_CLIENT_ID=your-integration-key
DOCUSIGN_USER_ID=your-user-id
DOCUSIGN_PRIVATE_KEY_PATH=./certs/docusign.pem
DOCUSIGN_BASE_URL=https://demo.docusign.net/restapi
DOCUSIGN_TEMPLATE_ID=your-template-id
DOCUSIGN_HMAC_KEY=your-hmac-secret

# Downstream API
DOWNSTREAM_API_URL=https://your-api.example.com/endpoint
DOWNSTREAM_API_KEY=your-downstream-api-key

# Email Alerts
ALERT_EMAIL=ops@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASS=your-smtp-password

# Database (Supabase PostgreSQL)
DATABASE_URL=postgresql://postgres.[your-project-ref]:[your-password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres

# Logging
LOG_LEVEL=info
```

### 3. Set Up DocuSign RSA Key

Place your DocuSign RSA private key in the `certs` directory:

```bash
mkdir -p certs
# Copy your private key to certs/docusign.pem
```

### 4. Run Migrations

```bash
npm run migrate
```

### 5. Start the Server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

### 6. Verify Installation

```bash
# Health check
curl http://localhost:3000/health

# Access dashboard
open "http://localhost:3000/dashboard?api_key=your-api-key"
```

## API Reference

### Authentication

All API endpoints require the `x-api-key` header:

```bash
curl -H "x-api-key: your-api-key" http://localhost:3000/api/v1/envelopes
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (no auth) |
| `POST` | `/api/v1/envelopes` | Submit document for signature |
| `GET` | `/api/v1/envelopes` | List envelopes with filters |
| `GET` | `/api/v1/envelopes/:jobId` | Get job details and timeline |
| `GET` | `/api/v1/envelopes/:jobId/document` | Download signed PDF |
| `POST` | `/api/v1/envelopes/:jobId/retry` | Retry failed downstream push |
| `POST` | `/api/v1/webhook/docusign` | DocuSign webhook (HMAC auth) |
| `GET` | `/dashboard` | Monitoring dashboard |

### Submit Document

```bash
curl -X POST http://localhost:3000/api/v1/envelopes \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "owner": {
      "firstName": "John",
      "middleName": "Michael",
      "lastName": "Doe",
      "ownerNumber": "OWN-12345",
      "email": "john.doe@example.com",
      "phone": "555-123-4567",
      "address": "123 Main St, Springfield, IL 62701"
    },
    "asset": {
      "assetNumber": "ASSET-001",
      "assetName": "Company Vehicle",
      "assetLocation": "456 Warehouse Dr, Chicago, IL 60601"
    },
    "transferee": {
      "firstName": "Jane",
      "middleName": "Marie",
      "lastName": "Smith"
    }
  }'
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `owner.firstName` | string | Yes | Owner's first name |
| `owner.middleName` | string | No | Owner's middle name |
| `owner.lastName` | string | Yes | Owner's last name |
| `owner.ownerNumber` | string | No | Owner identifier/number |
| `owner.phone` | string | No | Owner's phone number |
| `owner.email` | string | Yes | Owner's email (valid format) |
| `owner.address` | string | Yes | Owner's address |
| `asset.assetNumber` | string | Yes | Asset identifier |
| `asset.assetName` | string | Yes | Asset name/description |
| `asset.assetLocation` | string | Yes | Asset location |
| `transferee.firstName` | string | Yes | Transferee's first name |
| `transferee.middleName` | string | No | Transferee's middle name |
| `transferee.lastName` | string | Yes | Transferee's last name |

**Response:**

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "envelopeId": "d1f7a8b2-3c4d-5e6f-7890-abcdef123456",
  "status": "SENT"
}
```

### Idempotency

To prevent duplicate envelopes, include an idempotency key:

```bash
curl -X POST http://localhost:3000/api/v1/envelopes \
  -H "x-api-key: your-api-key" \
  -H "Idempotency-Key: unique-request-id-123" \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

## Supabase Setup

### 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in
2. Click "New Project"
3. Enter a project name and database password (save this password!)
4. Select a region close to your users
5. Wait for the project to be provisioned

### 2. Get Database Connection String

1. Go to **Project Settings** (gear icon)
2. Click **Database** in the sidebar
3. Scroll to **Connection string** section
4. Select **URI** tab
5. Copy the connection string
6. Replace `[YOUR-PASSWORD]` with your database password

Example:
```
postgresql://postgres.abcdefghijklmnop:YourPassword123@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

### 3. Run Migrations

The migrations will automatically create the required tables:

```bash
npm run migrate
```

This creates:
- `envelopes` - Job tracking
- `events` - Event audit trail
- `errors` - Error logging

### 4. Verify Connection

```bash
npm run dev
# Should see: "Server started successfully" with "database: PostgreSQL"
```

---

## DocuSign Setup

### 1. Create Integration Key

1. Go to [DocuSign Developer Center](https://developers.docusign.com/)
2. Create a new app with "Authorization Code Grant" and "JWT Grant"
3. Generate an RSA key pair and save the private key
4. Note your Integration Key (Client ID)

### 2. Grant Consent

Visit the consent URL in your browser:

```
https://account-d.docusign.com/oauth/auth?
  response_type=code&
  scope=signature%20impersonation&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://localhost
```

### 3. Create Template

Create a DocuSign template with these tab labels:

| Tab Label | Type | Description |
|-----------|------|-------------|
| `ownerFirstName` | Text | Owner's first name |
| `ownerMiddleName` | Text | Owner's middle name (optional) |
| `ownerLastName` | Text | Owner's last name |
| `ownerNumber` | Text | Owner identifier/number (optional) |
| `ownerPhone` | Text | Owner's phone (optional) |
| `ownerEmail` | Text | Owner's email |
| `ownerAddress` | Text | Owner's address |
| `assetNumber` | Text | Asset identifier |
| `assetName` | Text | Asset name/description |
| `assetLocation` | Text | Asset location |
| `transfereeFirstName` | Text | Transferee's first name |
| `transfereeMiddleName` | Text | Transferee's middle name (optional) |
| `transfereeLastName` | Text | Transferee's last name |

### 4. Configure Connect (Webhooks)

1. Go to Settings > Connect in DocuSign
2. Create a new configuration
3. Set the URL to: `https://your-domain.com/api/v1/webhook/docusign`
4. Enable HMAC signature
5. Select envelope events: Sent, Delivered, Completed, Declined, Voided

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- tests/extractor.test.js

# Watch mode
npm run test:watch
```

## Project Structure

```
docusign-layer/
├── src/
│   ├── app.js                 # Express app factory
│   ├── server.js              # Server entry point
│   ├── config/
│   │   └── index.js           # Configuration loader
│   ├── routes/
│   │   ├── envelopes.js       # Envelope API routes
│   │   ├── webhook.js         # Webhook handler
│   │   └── dashboard.js       # Dashboard routes
│   ├── services/
│   │   ├── docusignService.js # DocuSign SDK wrapper
│   │   ├── extractorService.js# Data extraction
│   │   ├── pushService.js     # Downstream API client
│   │   └── alertService.js    # Email alerts
│   ├── middleware/
│   │   ├── apiKeyAuth.js      # API key validation
│   │   ├── hmacValidator.js   # HMAC signature validation
│   │   └── requestLogger.js   # Request logging
│   ├── db/
│   │   ├── client.js          # Database abstraction
│   │   ├── migrate.js         # Migration runner
│   │   └── migrations/        # SQL migrations
│   └── utils/
│       ├── logger.js          # Pino logger
│       └── retry.js           # Retry helper
├── tests/
├── certs/                     # DocuSign RSA keys
├── storage/signed/            # Downloaded signed PDFs
├── .env.example
├── package.json
└── README.md
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | No | Environment: development, production, test |
| `PORT` | No | Server port (default: 3000) |
| `API_KEY` | Yes | API key for authentication |
| `DOCUSIGN_ACCOUNT_ID` | Yes | DocuSign account GUID |
| `DOCUSIGN_CLIENT_ID` | Yes | DocuSign Integration Key |
| `DOCUSIGN_USER_ID` | Yes | DocuSign user GUID |
| `DOCUSIGN_PRIVATE_KEY_PATH` | * | Path to RSA private key (for local/traditional hosting) |
| `DOCUSIGN_PRIVATE_KEY` | * | RSA private key content (for serverless/Vercel) |
| `DOCUSIGN_BASE_URL` | Yes | DocuSign API base URL |
| `DOCUSIGN_TEMPLATE_ID` | Yes | Template GUID |
| `DOCUSIGN_HMAC_KEY` | Yes | HMAC secret for webhooks |
| `DOWNSTREAM_API_URL` | Yes | Target API endpoint |
| `DOWNSTREAM_API_KEY` | Yes | Downstream API auth |
| `ALERT_EMAIL` | Yes | Alert recipient email |
| `SMTP_HOST` | Yes | SMTP server host |
| `SMTP_PORT` | Yes | SMTP server port |
| `SMTP_USER` | Yes | SMTP username |
| `SMTP_PASS` | Yes | SMTP password |
| `DATABASE_URL` | Yes | Supabase PostgreSQL connection string |
| `LOG_LEVEL` | No | Logging level (default: info) |
| `SIGNED_DOCS_PATH` | No | Signed PDF storage path |

\* One of `DOCUSIGN_PRIVATE_KEY_PATH` or `DOCUSIGN_PRIVATE_KEY` is required.

## Production Deployment

### Supabase (Recommended)

The application is configured to work with Supabase out of the box:

1. Create a Supabase project at [supabase.com](https://supabase.com)
2. Copy the connection string from Settings > Database
3. Set `DATABASE_URL` in your environment
4. Run migrations: `npm run migrate`

### HTTPS

The application should be deployed behind a reverse proxy (nginx, Traefik) that handles TLS termination. DocuSign webhooks require HTTPS.

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
```

### Vercel

The application includes a serverless entry point for Vercel deployment:

1. Connect your repository to Vercel
2. Set environment variables in Vercel project settings:
   - Use `DOCUSIGN_PRIVATE_KEY` instead of `DOCUSIGN_PRIVATE_KEY_PATH`
   - Paste the full contents of your RSA private key (including BEGIN/END lines)
3. Deploy

**Note:** File-based storage (`SIGNED_DOCS_PATH`) won't work on Vercel. For production, consider using Supabase Storage for signed documents.

### Environment Variables for Production

```bash
# Required for production
NODE_ENV=production
API_KEY=<strong-random-key>
DATABASE_URL=<supabase-connection-string>

# DocuSign production URLs
DOCUSIGN_BASE_URL=https://na4.docusign.net/restapi  # Use production URL
```

## Troubleshooting

### DocuSign Authentication Failed

1. Verify the RSA private key is correct and matches the public key in DocuSign
2. Ensure consent has been granted for the user
3. Check that the account ID, client ID, and user ID are correct

### Webhook Not Received

1. Verify the webhook URL is publicly accessible
2. Check that HTTPS is configured (DocuSign requires HTTPS)
3. Verify the HMAC key matches the Connect configuration

### Supabase Connection Failed

1. Verify the connection string is correct
2. Check that you replaced `[YOUR-PASSWORD]` with actual password
3. Ensure you're using the **pooler** connection string (port 6543)
4. Check that your IP is not blocked by Supabase

### Database Migration Failed

If migrations fail on Supabase, you can run them manually in the SQL Editor:

1. Go to Supabase Dashboard > SQL Editor
2. Copy contents from `src/db/migrations/*.sql`
3. Run each migration in order

## License

ISC
