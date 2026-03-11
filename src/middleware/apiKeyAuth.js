const { logger } = require('../utils/logger');

/**
 * API Key authentication middleware
 * Validates the x-api-key header against the configured API_KEY
 *
 * Usage:
 *   app.use('/api', apiKeyAuth);
 *
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {Function} next - Next middleware
 */
function apiKeyAuth(req, res, next) {
  // Skip auth for health check endpoint
  if (req.path === '/health') {
    return next();
  }

  const apiKey = req.headers['x-api-key'];
  const config = require('../config');

  if (!apiKey) {
    logger.warn({ path: req.path, ip: req.ip }, 'Missing API key in request');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing x-api-key header'
    });
  }

  if (apiKey !== config.apiKey) {
    logger.warn({ path: req.path, ip: req.ip }, 'Invalid API key in request');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key'
    });
  }

  next();
}

/**
 * API Key authentication for dashboard (via query param or header)
 * Allows ?api_key= query parameter for browser access
 */
function dashboardAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  const config = require('../config');

  if (!apiKey) {
    // Redirect to login or show error page
    return res.status(401).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Unauthorized</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1>401 Unauthorized</h1>
          <p>Please provide an API key via the <code>api_key</code> query parameter.</p>
          <p>Example: <code>/dashboard?api_key=your-api-key</code></p>
        </body>
      </html>
    `);
  }

  if (apiKey !== config.apiKey) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Unauthorized</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1>401 Unauthorized</h1>
          <p>Invalid API key provided.</p>
        </body>
      </html>
    `);
  }

  // Store API key in request for use in links
  req.apiKey = apiKey;
  next();
}

module.exports = {
  apiKeyAuth,
  dashboardAuth
};
