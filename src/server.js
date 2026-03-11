/**
 * DocuSign Integration Layer - Server Entry Point
 *
 * This is the main entry point that initializes the database,
 * runs migrations, creates the Express app, and starts the HTTP server.
 */

// Load environment variables first
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');

// Validate configuration before proceeding
let config;
try {
  config = require('./config');
} catch (error) {
  console.error('Configuration error:', error.message);
  process.exit(1);
}

const createApp = require('./app');
const db = require('./db/client');
const { run: runMigrations } = require('./db/migrate');
const { logger } = require('./utils/logger');

// Track active connections for graceful shutdown
const connections = new Set();

/**
 * Start the server
 */
async function start() {
  try {
    logger.info({ nodeEnv: config.nodeEnv }, 'Starting DocuSign Integration Layer');

    // Ensure storage directories exist
    ensureDirectories();

    // Initialize database connection
    if (config.isSQLite) {
      logger.info('Initializing SQLite database...');
      await db.initialize({ type: 'sqlite', url: config.databaseUrl });
      await runMigrations();
    } else {
      logger.info('Initializing Supabase database...');
      await db.initialize({
        type: 'supabase',
        url: config.supabase.url,
        serviceRoleKey: config.supabase.serviceRoleKey
      });
    }

    // Create Express app
    const app = createApp(config);
    const server = http.createServer(app);

    // Track connections for graceful shutdown
    server.on('connection', (conn) => {
      connections.add(conn);
      conn.on('close', () => connections.delete(conn));
    });

    // Start listening
    server.listen(config.port, () => {
      logger.info({
        port: config.port,
        nodeEnv: config.nodeEnv,
        database: config.isSQLite ? 'SQLite' : 'PostgreSQL'
      }, 'Server started successfully');

      logger.info(`Health check: http://localhost:${config.port}/health`);
      logger.info(`Dashboard: http://localhost:${config.port}/dashboard?api_key=<your-api-key>`);
    });

    // Setup graceful shutdown
    setupGracefulShutdown(server);

    return server;
  } catch (error) {
    logger.fatal({ error: error.message, stack: error.stack }, 'Failed to start server');
    process.exit(1);
  }
}

/**
 * Ensure required directories exist
 */
function ensureDirectories() {
  const dirs = [config.signedDocsPath];

  // Only add database directory for SQLite
  if (config.isSQLite && config.databaseUrl) {
    dirs.push(path.dirname(config.databaseUrl.replace('file:', '')));
  }

  for (const dir of dirs) {
    if (dir && !dir.includes(':')) {
      const resolvedDir = path.isAbsolute(dir)
        ? dir
        : path.resolve(process.cwd(), dir);

      if (!fs.existsSync(resolvedDir)) {
        fs.mkdirSync(resolvedDir, { recursive: true });
        logger.info({ directory: resolvedDir }, 'Created directory');
      }
    }
  }
}

/**
 * Setup graceful shutdown handlers
 */
function setupGracefulShutdown(server) {
  let isShuttingDown = false;

  async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, 'Shutdown signal received, starting graceful shutdown');

    // Give existing requests time to complete
    const shutdownTimeout = setTimeout(() => {
      logger.warn('Shutdown timeout reached, forcing exit');
      connections.forEach((conn) => conn.destroy());
      process.exit(1);
    }, 30000); // 30 second timeout

    // Stop accepting new connections
    server.close(async () => {
      logger.info('HTTP server closed');

      try {
        // Close database connection
        await db.close();
        logger.info('Database connection closed');

        clearTimeout(shutdownTimeout);
        logger.info('Graceful shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error({ error: error.message }, 'Error during shutdown');
        clearTimeout(shutdownTimeout);
        process.exit(1);
      }
    });

    // Close keep-alive connections
    connections.forEach((conn) => {
      conn.end();
    });
  }

  // Handle shutdown signals
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason: String(reason) }, 'Unhandled rejection');
  });
}

// Start the server if this is the main module
if (require.main === module) {
  start();
}

module.exports = { start };
