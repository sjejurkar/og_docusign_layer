const nock = require('nock');

// Mock config before requiring pushService
jest.mock('../src/config', () => ({
  downstream: {
    apiUrl: 'https://api.example.com/v1/transfers',
    apiKey: 'test-api-key-12345'
  },
  logLevel: 'error' // Suppress logs during tests
}));

const { PushService } = require('../src/services/pushService');

describe('PushService', () => {
  let pushService;
  const testConfig = {
    downstream: {
      apiUrl: 'https://api.example.com/v1/transfers',
      apiKey: 'test-api-key-12345'
    }
  };

  const samplePayload = {
    jobId: 'job-123-456-789',
    envelopeId: 'env-abc-def-ghi',
    signedAt: '2024-03-15T14:30:00.000Z',
    owner: {
      firstName: 'John',
      middleName: 'Robert',
      lastName: 'Doe',
      ownerNumber: 'OWN-12345',
      phone: '555-1234',
      email: 'john@example.com',
      address: '123 Main St'
    },
    asset: {
      assetNumber: 'ASSET-001',
      assetName: 'Company Vehicle',
      assetLocation: '456 Warehouse Dr'
    },
    transferee: {
      firstName: 'Jane',
      middleName: 'Marie',
      lastName: 'Smith'
    },
    documentUrl: '/api/v1/envelopes/job-123-456-789/document'
  };

  beforeEach(() => {
    pushService = new PushService(testConfig);
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    nock.restore();
  });

  describe('pushData', () => {
    test('successfully pushes data on first attempt', async () => {
      nock('https://api.example.com')
        .post('/v1/transfers/')
        .matchHeader('Authorization', 'Bearer test-api-key-12345')
        .matchHeader('Content-Type', 'application/json')
        .reply(200, { success: true, id: 'downstream-123' });

      const result = await pushService.pushData(samplePayload);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.data).toEqual({ success: true, id: 'downstream-123' });
    });

    test('retries on 500 error and succeeds on second attempt', async () => {
      nock('https://api.example.com')
        .post('/v1/transfers/')
        .reply(500, { error: 'Internal Server Error' })
        .post('/v1/transfers/')
        .reply(200, { success: true });

      const result = await pushService.pushData(samplePayload);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    test('retries on 503 Service Unavailable', async () => {
      nock('https://api.example.com')
        .post('/v1/transfers/')
        .reply(503, { error: 'Service Unavailable' })
        .post('/v1/transfers/')
        .reply(200, { success: true });

      const result = await pushService.pushData(samplePayload);

      expect(result.success).toBe(true);
    });

    test('retries on 429 Too Many Requests', async () => {
      nock('https://api.example.com')
        .post('/v1/transfers/')
        .reply(429, { error: 'Rate limit exceeded' })
        .post('/v1/transfers/')
        .reply(200, { success: true });

      const result = await pushService.pushData(samplePayload);

      expect(result.success).toBe(true);
    });

    test('does not retry on 400 Bad Request', async () => {
      nock('https://api.example.com')
        .post('/v1/transfers/')
        .reply(400, { error: 'Bad Request', message: 'Invalid payload' });

      await expect(pushService.pushData(samplePayload)).rejects.toThrow();

      // Verify only one request was made
      expect(nock.isDone()).toBe(true);
    });

    test('does not retry on 401 Unauthorized', async () => {
      nock('https://api.example.com')
        .post('/v1/transfers/')
        .reply(401, { error: 'Unauthorized' });

      await expect(pushService.pushData(samplePayload)).rejects.toThrow();
    });

    test('does not retry on 404 Not Found', async () => {
      nock('https://api.example.com')
        .post('/v1/transfers/')
        .reply(404, { error: 'Not Found' });

      await expect(pushService.pushData(samplePayload)).rejects.toThrow();
    });

    test('throws after all retries exhausted', async () => {
      nock('https://api.example.com')
        .post('/v1/transfers/')
        .reply(500, { error: 'Error 1' })
        .post('/v1/transfers/')
        .reply(500, { error: 'Error 2' })
        .post('/v1/transfers/')
        .reply(500, { error: 'Error 3' })
        .post('/v1/transfers/')
        .reply(500, { error: 'Error 4' });

      await expect(pushService.pushData(samplePayload)).rejects.toThrow();
    }, 30000); // Increase timeout for retries

    test('handles network errors', async () => {
      nock('https://api.example.com')
        .post('/v1/transfers/')
        .replyWithError({ code: 'ECONNRESET' })
        .post('/v1/transfers/')
        .reply(200, { success: true });

      const result = await pushService.pushData(samplePayload);

      expect(result.success).toBe(true);
    });

    test('handles timeout errors', async () => {
      nock('https://api.example.com')
        .post('/v1/transfers/')
        .replyWithError({ code: 'ETIMEDOUT' })
        .post('/v1/transfers/')
        .reply(200, { success: true });

      const result = await pushService.pushData(samplePayload);

      expect(result.success).toBe(true);
    });

    test('includes correct headers', async () => {
      let capturedHeaders;

      nock('https://api.example.com')
        .post('/v1/transfers/')
        .reply(function(uri, body) {
          capturedHeaders = this.req.headers;
          return [200, { success: true }];
        });

      await pushService.pushData(samplePayload);

      expect(capturedHeaders['authorization']).toBe('Bearer test-api-key-12345');
      expect(capturedHeaders['content-type']).toBe('application/json');
    });

    test('sends correct payload format', async () => {
      let capturedBody;

      nock('https://api.example.com')
        .post('/v1/transfers/', (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, { success: true });

      await pushService.pushData(samplePayload);

      expect(capturedBody.jobId).toBe(samplePayload.jobId);
      expect(capturedBody.owner.firstName).toBe(samplePayload.owner.firstName);
      expect(capturedBody.asset.assetNumber).toBe(samplePayload.asset.assetNumber);
      expect(capturedBody.transferee.firstName).toBe(samplePayload.transferee.firstName);
    });

    test('returns response data from downstream', async () => {
      const downstreamResponse = {
        id: 'transfer-12345',
        status: 'received',
        processedAt: '2024-03-15T14:35:00.000Z'
      };

      nock('https://api.example.com')
        .post('/v1/transfers/')
        .reply(201, downstreamResponse);

      const result = await pushService.pushData(samplePayload);

      expect(result.statusCode).toBe(201);
      expect(result.data).toEqual(downstreamResponse);
    });
  });

  describe('testConnection', () => {
    test('returns reachable true for successful HEAD request', async () => {
      nock('https://api.example.com')
        .head('/v1/transfers/')
        .reply(200);

      const result = await pushService.testConnection();

      expect(result.reachable).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    test('falls back to OPTIONS if HEAD not supported', async () => {
      nock('https://api.example.com')
        .head('/v1/transfers/')
        .reply(405) // Method Not Allowed
        .options('/v1/transfers/')
        .reply(200);

      const result = await pushService.testConnection();

      expect(result.reachable).toBe(true);
    });

    test('returns reachable true with error for 4xx responses', async () => {
      nock('https://api.example.com')
        .head('/v1/transfers/')
        .reply(401, { error: 'Unauthorized' });

      const result = await pushService.testConnection();

      expect(result.reachable).toBe(true);
      expect(result.statusCode).toBe(401);
    });

    test('returns reachable false for network errors', async () => {
      nock('https://api.example.com')
        .head('/v1/transfers/')
        .replyWithError({ code: 'ENOTFOUND' });

      const result = await pushService.testConnection();

      expect(result.reachable).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
