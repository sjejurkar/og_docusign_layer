const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { apiKeyAuth } = require('./middleware/apiKeyAuth');
const { createRequestLogger, addRequestContext } = require('./middleware/requestLogger');
const { logger } = require('./utils/logger');

/**
 * Create and configure Express application
 *
 * @param {Object} config - Application configuration
 * @returns {Express.Application} - Configured Express app
 */
function createApp(config) {
  const app = express();

  // Trust proxy for rate limiting and IP detection
  app.set('trust proxy', 1);

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"]
      }
    }
  }));

  // Rate limiting for submission endpoint
  const submissionLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60, // 60 requests per minute per API key
    keyGenerator: (req) => req.headers['x-api-key'] || req.ip,
    message: {
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Maximum 60 requests per minute.'
    },
    standardHeaders: true,
    legacyHeaders: false
  });

  // Body parsing with raw body capture for HMAC validation
  app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  // Text body parsing for XML webhooks
  app.use(express.text({
    type: ['application/xml', 'text/xml'],
    limit: '10mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  // URL encoded body parsing
  app.use(express.urlencoded({ extended: true }));

  // Request context and logging
  app.use(addRequestContext);
  app.use(createRequestLogger());

  // Health check endpoint (no auth required)
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0'
    });
  });

  // API routes (with auth and rate limiting)
  app.use('/api/v1/envelopes', apiKeyAuth, submissionLimiter, require('./routes/envelopes'));

  // Webhook routes (HMAC auth only, no API key)
  app.use('/api/v1/webhook', require('./routes/webhook'));

  // Dashboard routes (with auth)
  app.use('/dashboard', require('./routes/dashboard'));

  // Serve static files from dashboard
  app.use('/static', express.static(path.join(__dirname, 'dashboard', 'static')));

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      error: 'Not Found',
      message: `Cannot ${req.method} ${req.path}`
    });
  });

  // Global error handler
  app.use((err, req, res, next) => {
    const log = req.log || logger;

    // Log error
    log.error({
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method
    }, 'Request error');

    // Handle Zod validation errors
    if (err.name === 'ZodError') {
      return res.status(422).json({
        error: 'Validation Error',
        details: err.issues.map(issue => ({
          field: issue.path.join('.'),
          message: issue.message
        }))
      });
    }

    // Handle DocuSign API errors
    if (err.response && err.response.body) {
      return res.status(err.status || 502).json({
        error: 'DocuSign API Error',
        message: err.response.body.message || err.message
      });
    }

    // Generic error response
    const statusCode = err.status || err.statusCode || 500;
    res.status(statusCode).json({
      error: statusCode === 500 ? 'Internal Server Error' : err.name || 'Error',
      message: config.nodeEnv === 'production'
        ? 'An unexpected error occurred'
        : err.message
    });
  });

  return app;
}

module.exports = createApp;
