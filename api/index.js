/**
 * Vercel Serverless Entry Point
 *
 * This file exports the Express app for Vercel serverless deployment.
 * Unlike server.js which starts a traditional HTTP server, this module
 * simply exports the configured Express app for Vercel to handle.
 */

require('dotenv').config();

const config = require('../src/config');
const createApp = require('../src/app');
const db = require('../src/db/client');

// Initialize database once (cached across invocations)
let dbInitialized = false;

async function initializeDb() {
  if (!dbInitialized) {
    await db.initialize({
      url: config.supabase.url,
      serviceRoleKey: config.supabase.serviceRoleKey
    });
    dbInitialized = true;
  }
}

// Create Express app
const app = createApp(config);

// Wrap with async initialization
const handler = async (req, res) => {
  await initializeDb();
  return app(req, res);
};

module.exports = handler;
