const pinoHttp = require('pino-http');
const { v4: uuidv4 } = require('uuid');
const { logger, maskPII } = require('../utils/logger');

/**
 * Custom request serializer that masks PII fields
 */
function customReqSerializer(req) {
  const serialized = {
    id: req.id,
    method: req.method,
    url: req.url,
    query: req.query,
    headers: {
      'content-type': req.headers['content-type'],
      'user-agent': req.headers['user-agent'],
      'x-forwarded-for': req.headers['x-forwarded-for']
      // Exclude x-api-key and other sensitive headers
    }
  };

  // Mask body if present
  if (req.raw && req.raw.body) {
    serialized.body = maskPII(req.raw.body);
  }

  return serialized;
}

/**
 * Custom response serializer
 */
function customResSerializer(res) {
  return {
    statusCode: res.statusCode
  };
}

/**
 * Create request logging middleware
 * - Generates unique request ID for correlation
 * - Logs request/response with PII masking
 * - Attaches logger to request for use in handlers
 */
function createRequestLogger() {
  return pinoHttp({
    logger,

    // Generate unique request ID
    genReqId: (req) => {
      const existingId = req.headers['x-request-id'];
      return existingId || uuidv4();
    },

    // Custom serializers
    serializers: {
      req: customReqSerializer,
      res: customResSerializer,
      err: pinoHttp.stdSerializers.err
    },

    // Customize log level based on status code
    customLogLevel: (req, res, err) => {
      if (res.statusCode >= 500 || err) {
        return 'error';
      }
      if (res.statusCode >= 400) {
        return 'warn';
      }
      return 'info';
    },

    // Customize success message
    customSuccessMessage: (req, res) => {
      return `${req.method} ${req.url} ${res.statusCode}`;
    },

    // Customize error message
    customErrorMessage: (req, res, err) => {
      return `${req.method} ${req.url} ${res.statusCode} - ${err.message}`;
    },

    // Add custom attributes to log
    customAttributeKeys: {
      req: 'request',
      res: 'response',
      err: 'error',
      responseTime: 'duration'
    },

    // Don't log health check requests
    autoLogging: {
      ignore: (req) => req.url === '/health'
    }
  });
}

/**
 * Middleware to add request context to all child loggers
 */
function addRequestContext(req, res, next) {
  // Ensure request has an ID
  req.id = req.id || req.headers['x-request-id'] || uuidv4();

  // Set response header for tracing
  res.setHeader('X-Request-ID', req.id);

  // Create child logger with request context
  req.log = logger.child({
    requestId: req.id
  });

  next();
}

module.exports = {
  createRequestLogger,
  addRequestContext
};
