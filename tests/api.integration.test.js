const request = require('supertest');
const crypto = require('crypto');

// Set up test environment
process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-api-key-1234567890';
process.env.DOCUSIGN_HMAC_KEY = 'test-hmac-key-1234567890';
process.env.DATABASE_URL = 'file::memory:';
process.env.LOG_LEVEL = 'error';

// Mock external services
jest.mock('../src/services/docusignService', () => ({
  getInstance: () => ({
    authenticate: jest.fn().mockResolvedValue('mock-token'),
    createEnvelopeFromTemplate: jest.fn().mockResolvedValue('mock-envelope-id-12345'),
    getEnvelopeTabs: jest.fn().mockResolvedValue({
      ownerFirstName: 'John',
      ownerMiddleName: 'Robert',
      ownerLastName: 'Doe',
      ownerNumber: 'OWN-12345',
      ownerPhone: '555-1234',
      ownerEmail: 'test@example.com',
      ownerAddress: '123 Test St',
      assetNumber: 'ASSET-001',
      assetName: 'Test Asset',
      assetLocation: '456 Asset Lane',
      transfereeFirstName: 'Jane',
      transfereeMiddleName: 'Marie',
      transfereeLastName: 'Smith'
    }),
    downloadSignedDocument: jest.fn().mockResolvedValue('/tmp/test.pdf')
  })
}));

jest.mock('../src/services/pushService', () => ({
  getInstance: () => ({
    pushData: jest.fn().mockResolvedValue({ success: true, statusCode: 200 })
  })
}));

jest.mock('../src/services/alertService', () => ({
  getInstance: () => ({
    sendAlert: jest.fn().mockResolvedValue(true)
  })
}));

// Mock config
jest.mock('../src/config', () => ({
  nodeEnv: 'test',
  port: 3000,
  apiKey: 'test-api-key-1234567890',
  docusign: {
    accountId: 'test-account-id',
    clientId: 'test-client-id',
    userId: 'test-user-id',
    privateKeyPath: './certs/test.pem',
    baseUrl: 'https://demo.docusign.net/restapi',
    templateId: 'test-template-id',
    hmacKey: 'test-hmac-key-1234567890'
  },
  downstream: {
    apiUrl: 'https://api.example.com/v1/transfers',
    apiKey: 'test-downstream-key'
  },
  alert: { email: 'test@example.com' },
  smtp: { host: 'smtp.test.com', port: 587, user: 'test', pass: 'test' },
  supabase: { url: 'https://test.supabase.co', anonKey: 'test-key' },
  logLevel: 'error',
  signedDocsPath: '/tmp/test-signed',
  isSQLite: true,
  baseUrl: 'http://localhost:3000'
}));

const createApp = require('../src/app');
const db = require('../src/db/client');

describe('API Integration Tests', () => {
  let app;

  beforeAll(async () => {
    // Initialize in-memory database
    await db.initialize('file::memory:');

    // Create tables
    const tables = `
      CREATE TABLE IF NOT EXISTS envelopes (
        id TEXT PRIMARY KEY,
        envelope_id TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        customer_name TEXT NOT NULL,
        customer_email TEXT NOT NULL,
        request_payload TEXT NOT NULL,
        extracted_data TEXT,
        document_path TEXT,
        callback_url TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS errors (
        id TEXT PRIMARY KEY,
        job_id TEXT,
        error_type TEXT NOT NULL,
        message TEXT NOT NULL,
        stack_trace TEXT,
        alert_sent INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    db.getDb().exec(tables);

    const config = require('../src/config');
    app = createApp(config);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    // Clear tables before each test
    db.getDb().exec('DELETE FROM errors');
    db.getDb().exec('DELETE FROM events');
    db.getDb().exec('DELETE FROM envelopes');
  });

  describe('GET /health', () => {
    test('returns 200 with status ok', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.timestamp).toBeDefined();
    });

    test('does not require authentication', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/v1/envelopes', () => {
    const validPayload = {
      owner: {
        firstName: 'John',
        middleName: 'Robert',
        lastName: 'Doe',
        ownerNumber: 'OWN-12345',
        phone: '555-123-4567',
        email: 'john.doe@example.com',
        address: '123 Main St, Springfield, IL 62701'
      },
      asset: {
        assetNumber: 'ASSET-001',
        assetName: 'Company Vehicle',
        assetLocation: '456 Warehouse Dr, Chicago, IL 60601'
      },
      transferee: {
        firstName: 'Jane',
        middleName: 'Marie',
        lastName: 'Smith'
      }
    };

    test('requires API key', async () => {
      const response = await request(app)
        .post('/api/v1/envelopes')
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
    });

    test('rejects invalid API key', async () => {
      const response = await request(app)
        .post('/api/v1/envelopes')
        .set('x-api-key', 'wrong-key')
        .send(validPayload);

      expect(response.status).toBe(401);
    });

    test('returns 422 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/envelopes')
        .set('x-api-key', 'test-api-key-1234567890')
        .send({});

      expect(response.status).toBe(422);
      expect(response.body.error).toBe('Validation Error');
      expect(response.body.details).toBeDefined();
    });

    test('returns 422 for invalid email', async () => {
      const invalidPayload = {
        owner: { ...validPayload.owner, email: 'not-an-email' },
        asset: validPayload.asset,
        transferee: validPayload.transferee
      };

      const response = await request(app)
        .post('/api/v1/envelopes')
        .set('x-api-key', 'test-api-key-1234567890')
        .send(invalidPayload);

      expect(response.status).toBe(422);
    });

    test('returns 422 for missing asset fields', async () => {
      const payloadMissingAsset = {
        owner: validPayload.owner,
        transferee: validPayload.transferee
      };

      const response = await request(app)
        .post('/api/v1/envelopes')
        .set('x-api-key', 'test-api-key-1234567890')
        .send(payloadMissingAsset);

      expect(response.status).toBe(422);
      expect(response.body.details.some(d => d.field.includes('asset'))).toBe(true);
    });

    test('returns 422 for missing transferee fields', async () => {
      const payloadMissingTransferee = {
        owner: validPayload.owner,
        asset: validPayload.asset
      };

      const response = await request(app)
        .post('/api/v1/envelopes')
        .set('x-api-key', 'test-api-key-1234567890')
        .send(payloadMissingTransferee);

      expect(response.status).toBe(422);
      expect(response.body.details.some(d => d.field.includes('transferee'))).toBe(true);
    });

    test('accepts optional transferee middleName', async () => {
      const payloadNoMiddle = {
        owner: validPayload.owner,
        asset: validPayload.asset,
        transferee: {
          firstName: 'Jane',
          lastName: 'Smith'
        }
      };

      const response = await request(app)
        .post('/api/v1/envelopes')
        .set('x-api-key', 'test-api-key-1234567890')
        .send(payloadNoMiddle);

      expect(response.status).toBe(202);
    });

    test('creates envelope with valid payload', async () => {
      const response = await request(app)
        .post('/api/v1/envelopes')
        .set('x-api-key', 'test-api-key-1234567890')
        .send(validPayload);

      expect(response.status).toBe(202);
      expect(response.body.jobId).toBeDefined();
      expect(response.body.envelopeId).toBe('mock-envelope-id-12345');
      expect(response.body.status).toBe('SENT');
    });

    test('handles idempotency key', async () => {
      const payloadWithKey = { ...validPayload, idempotencyKey: 'unique-key-123' };

      // First request
      const response1 = await request(app)
        .post('/api/v1/envelopes')
        .set('x-api-key', 'test-api-key-1234567890')
        .send(payloadWithKey);

      expect(response1.status).toBe(202);

      // Second request with same key
      const response2 = await request(app)
        .post('/api/v1/envelopes')
        .set('x-api-key', 'test-api-key-1234567890')
        .send(payloadWithKey);

      expect(response2.status).toBe(200); // Returns cached
      expect(response2.body.jobId).toBe(response1.body.jobId);
    });
  });

  describe('GET /api/v1/envelopes', () => {
    test('requires API key', async () => {
      const response = await request(app).get('/api/v1/envelopes');

      expect(response.status).toBe(401);
    });

    test('returns empty list when no envelopes', async () => {
      const response = await request(app)
        .get('/api/v1/envelopes')
        .set('x-api-key', 'test-api-key-1234567890');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
    });

    test('filters by status', async () => {
      // Create a test envelope
      await db.run(
        `INSERT INTO envelopes (id, envelope_id, status, customer_name, customer_email, request_payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['job-1', 'env-1', 'COMPLETED', 'Test User', 'test@example.com', '{}']
      );

      const response = await request(app)
        .get('/api/v1/envelopes?status=COMPLETED')
        .set('x-api-key', 'test-api-key-1234567890');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].status).toBe('COMPLETED');
    });
  });

  describe('GET /api/v1/envelopes/:jobId', () => {
    test('returns 404 for non-existent job', async () => {
      const response = await request(app)
        .get('/api/v1/envelopes/non-existent-job-id')
        .set('x-api-key', 'test-api-key-1234567890');

      expect(response.status).toBe(404);
    });

    test('returns job details with events', async () => {
      // Create test envelope and event
      await db.run(
        `INSERT INTO envelopes (id, envelope_id, status, customer_name, customer_email, request_payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['job-123', 'env-123', 'SENT', 'Test User', 'test@example.com', '{}']
      );
      await db.run(
        `INSERT INTO events (id, job_id, event_type, payload)
         VALUES (?, ?, ?, ?)`,
        ['event-1', 'job-123', 'SUBMITTED', '{}']
      );

      const response = await request(app)
        .get('/api/v1/envelopes/job-123')
        .set('x-api-key', 'test-api-key-1234567890');

      expect(response.status).toBe(200);
      expect(response.body.jobId).toBe('job-123');
      expect(response.body.events).toHaveLength(1);
      expect(response.body.events[0].type).toBe('SUBMITTED');
    });
  });

  describe('POST /api/v1/webhook/docusign', () => {
    function generateHmacSignature(body, key) {
      return crypto
        .createHmac('sha256', key)
        .update(body)
        .digest('base64');
    }

    test('rejects request without signature', async () => {
      const response = await request(app)
        .post('/api/v1/webhook/docusign')
        .send({ envelopeId: 'test', status: 'completed' });

      expect(response.status).toBe(401);
      expect(response.body.message.toLowerCase()).toContain('signature');
    });

    test('rejects request with invalid signature', async () => {
      const response = await request(app)
        .post('/api/v1/webhook/docusign')
        .set('X-DocuSign-Signature-1', 'invalid-signature')
        .send({ envelopeId: 'test', status: 'completed' });

      expect(response.status).toBe(401);
    });

    test('accepts request with valid HMAC signature', async () => {
      const body = JSON.stringify({ envelopeId: 'test-env', status: 'completed' });
      const signature = generateHmacSignature(body, 'test-hmac-key-1234567890');

      const response = await request(app)
        .post('/api/v1/webhook/docusign')
        .set('X-DocuSign-Signature-1', signature)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(200);
      expect(response.body.received).toBe(true);
    });
  });

  describe('404 Handler', () => {
    test('returns 404 for unknown routes', async () => {
      const response = await request(app)
        .get('/api/v1/unknown-route')
        .set('x-api-key', 'test-api-key-1234567890');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Not Found');
    });
  });

  describe('Rate Limiting', () => {
    test('allows requests within rate limit', async () => {
      // Make a few requests
      for (let i = 0; i < 5; i++) {
        const response = await request(app)
          .get('/api/v1/envelopes')
          .set('x-api-key', 'test-api-key-1234567890');

        expect(response.status).toBe(200);
      }
    });
  });
});
