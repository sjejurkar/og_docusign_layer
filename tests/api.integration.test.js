const request = require('supertest');
const crypto = require('crypto');

// Set up test environment
process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-api-key-1234567890';
process.env.DOCUSIGN_HMAC_KEY = 'test-hmac-key-1234567890';
process.env.LOG_LEVEL = 'error';

// In-memory store for test data
const testStore = {
  envelopes: [],
  events: [],
  errors: []
};

// Mock database client
jest.mock('../src/db/client', () => ({
  initialize: jest.fn().mockResolvedValue({}),
  close: jest.fn().mockResolvedValue(undefined),
  getDb: jest.fn().mockReturnValue({}),
  query: jest.fn().mockImplementation(async (sql, params = []) => {
    const sqlLower = sql.toLowerCase();
    if (sqlLower.includes('from envelopes')) {
      if (sqlLower.includes('where id')) {
        return testStore.envelopes.filter(e => e.id === params[0]);
      }
      if (sqlLower.includes('where status')) {
        return testStore.envelopes.filter(e => e.status === params[0]);
      }
      if (sqlLower.includes('where idempotency_key')) {
        return testStore.envelopes.filter(e => e.idempotency_key === params[0]);
      }
      if (sqlLower.includes('count(*)')) {
        return [{ count: testStore.envelopes.length }];
      }
      return testStore.envelopes;
    }
    if (sqlLower.includes('from events')) {
      if (sqlLower.includes('where job_id')) {
        return testStore.events.filter(e => e.job_id === params[0]);
      }
      return testStore.events;
    }
    return [];
  }),
  run: jest.fn().mockImplementation(async (sql, params = []) => {
    const sqlLower = sql.toLowerCase();
    if (sqlLower.includes('insert into envelopes')) {
      const envelope = {
        id: params[0],
        envelope_id: params[1],
        status: params[2],
        customer_name: params[3],
        customer_email: params[4],
        request_payload: params[5],
        callback_url: params[6] || null,
        idempotency_key: params[7] || null
      };
      testStore.envelopes.push(envelope);
      return { changes: 1 };
    }
    if (sqlLower.includes('insert into events')) {
      testStore.events.push({
        id: params[0],
        job_id: params[1],
        event_type: params[2],
        payload: params[3]
      });
      return { changes: 1 };
    }
    return { changes: 0 };
  }),
  getOne: jest.fn().mockImplementation(async (sql, params = []) => {
    const sqlLower = sql.toLowerCase();
    if (sqlLower.includes('from envelopes')) {
      // Check idempotency_key BEFORE checking id (since 'where id' matches 'envelope_id')
      if (sqlLower.includes('idempotency_key')) {
        const found = testStore.envelopes.find(e => e.idempotency_key === params[0]);
        return found || null;
      }
      if (sqlLower.includes('where id =')) {
        return testStore.envelopes.find(e => e.id === params[0]) || null;
      }
    }
    return null;
  }),
  getMany: jest.fn().mockImplementation(async (sql, params = []) => {
    const sqlLower = sql.toLowerCase();
    if (sqlLower.includes('from events') && sqlLower.includes('where job_id')) {
      return testStore.events.filter(e => e.job_id === params[0]);
    }
    return [];
  })
}));

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
  supabase: { url: 'https://test.supabase.co', anonKey: 'test-key', serviceRoleKey: 'test-service-key' },
  logLevel: 'error',
  signedDocsPath: '/tmp/test-signed',
  baseUrl: 'http://localhost:3000'
}));

const createApp = require('../src/app');

describe('API Integration Tests', () => {
  let app;

  beforeAll(async () => {
    const config = require('../src/config');
    app = createApp(config);
  });

  beforeEach(async () => {
    // Clear test store before each test
    testStore.envelopes = [];
    testStore.events = [];
    testStore.errors = [];
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

    test('accepts null middleName for owner and transferee', async () => {
      const payloadNullMiddle = {
        owner: {
          firstName: 'John',
          middleName: null,
          lastName: 'Doe',
          ownerNumber: 'OWN-12345',
          phone: '555-123-4567',
          email: 'john.doe@example.com',
          address: '123 Main St, Springfield, IL 62701'
        },
        asset: validPayload.asset,
        transferee: {
          firstName: 'Jane',
          middleName: null,
          lastName: 'Smith'
        }
      };

      const response = await request(app)
        .post('/api/v1/envelopes')
        .set('x-api-key', 'test-api-key-1234567890')
        .send(payloadNullMiddle);

      expect(response.status).toBe(202);
      expect(response.body.jobId).toBeDefined();
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
      // Add test data to store
      testStore.envelopes.push({
        id: 'job-1',
        envelope_id: 'env-1',
        status: 'COMPLETED',
        customer_name: 'Test User',
        customer_email: 'test@example.com',
        request_payload: '{}'
      });

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
      // Add test data to store
      testStore.envelopes.push({
        id: 'job-123',
        envelope_id: 'env-123',
        status: 'SENT',
        customer_name: 'Test User',
        customer_email: 'test@example.com',
        request_payload: '{}'
      });
      testStore.events.push({
        id: 'event-1',
        job_id: 'job-123',
        event_type: 'SUBMITTED',
        payload: '{}'
      });

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
