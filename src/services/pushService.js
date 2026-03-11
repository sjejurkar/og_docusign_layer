const axios = require('axios');
const { withRetry, isRetryableHttpError } = require('../utils/retry');
const { logger, maskPII } = require('../utils/logger');

class PushService {
  constructor(config) {
    this.config = config;
    this.log = logger.child({ service: 'push' });

    // Create axios instance with defaults
    this.client = axios.create({
      baseURL: config.downstream.apiUrl,
      timeout: 30000, // 30 second timeout
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.downstream.apiKey}`
      }
    });

    // Log outgoing requests (at debug level)
    this.client.interceptors.request.use(request => {
      this.log.debug({
        method: request.method,
        url: request.url,
        body: maskPII(request.data)
      }, 'Outgoing downstream request');
      return request;
    });

    // Log responses
    this.client.interceptors.response.use(
      response => {
        this.log.debug({
          status: response.status,
          url: response.config.url
        }, 'Downstream response received');
        return response;
      },
      error => {
        this.log.warn({
          status: error.response?.status,
          message: error.message,
          url: error.config?.url
        }, 'Downstream request failed');
        return Promise.reject(error);
      }
    );
  }

  /**
   * Push extracted data to downstream API
   * Implements retry with exponential backoff (1s, 5s, 15s)
   *
   * @param {Object} payload - Canonical data payload to push
   * @returns {Object} - Result { success: boolean, statusCode: number, data: any }
   * @throws {Error} - After all retries exhausted
   */
  async pushData(payload) {
    const log = this.log.child({
      jobId: payload.jobId,
      envelopeId: payload.envelopeId
    });

    log.info('Starting downstream push');

    try {
      const result = await withRetry(
        async (attempt) => {
          log.info({ attempt: attempt + 1 }, 'Attempting downstream push');

          const response = await this.client.post('/', payload);

          return {
            success: true,
            statusCode: response.status,
            data: response.data,
            attempt: attempt + 1
          };
        },
        {
          retries: 3,
          delays: [1000, 5000, 15000], // 1s, 5s, 15s
          shouldRetry: isRetryableHttpError,
          context: { jobId: payload.jobId, envelopeId: payload.envelopeId }
        }
      );

      log.info({
        statusCode: result.statusCode,
        attempts: result.attempt
      }, 'Downstream push successful');

      return result;
    } catch (error) {
      log.error({
        error: error.message,
        statusCode: error.response?.status
      }, 'Downstream push failed after all retries');

      throw error;
    }
  }

  /**
   * Test connectivity to downstream API
   *
   * @returns {Object} - { reachable: boolean, statusCode?: number, error?: string }
   */
  async testConnection() {
    try {
      // Try a HEAD request to test connectivity
      const response = await this.client.head('/');
      return {
        reachable: true,
        statusCode: response.status
      };
    } catch (error) {
      // If HEAD not supported, try OPTIONS
      if (error.response?.status === 405) {
        try {
          const response = await this.client.options('/');
          return {
            reachable: true,
            statusCode: response.status
          };
        } catch (optionsError) {
          return {
            reachable: false,
            error: optionsError.message
          };
        }
      }

      // Check if we got a response (server is reachable but returned error)
      if (error.response) {
        return {
          reachable: true,
          statusCode: error.response.status,
          error: `Server returned ${error.response.status}`
        };
      }

      return {
        reachable: false,
        error: error.message
      };
    }
  }
}

// Singleton instance
let instance = null;

function getInstance(config) {
  if (!instance) {
    instance = new PushService(config);
  }
  return instance;
}

module.exports = {
  PushService,
  getInstance
};
