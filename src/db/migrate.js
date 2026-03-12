const fs = require('fs');
const path = require('path');
const db = require('./client');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Run all pending database migrations (Supabase)
 */
async function run() {
  // Get Supabase config from environment
  require('dotenv').config();

  // Initialize Supabase database
  await db.initialize({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  });

  console.log('Running database migrations...');

  // Create migrations tracking table
  const createMigrationsTable = `
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db.run(createMigrationsTable);

  // Get list of applied migrations
  const applied = await db.query('SELECT name FROM _migrations ORDER BY name');
  const appliedNames = new Set(applied.map(row => row.name));

  // Get all migration files
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  // Apply pending migrations
  for (const file of files) {
    if (appliedNames.has(file)) {
      console.log(`  Skipping ${file} (already applied)`);
      continue;
    }

    console.log(`  Applying ${file}...`);

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

    try {
      await db.run(sql);

      // Record migration as applied
      await db.run(
        'INSERT INTO _migrations (name) VALUES (?)',
        [file]
      );

      console.log(`  Applied ${file}`);
    } catch (error) {
      console.error(`  Failed to apply ${file}: ${error.message}`);
      throw error;
    }
  }

  console.log('Migrations complete.');
}

// Run migrations if called directly
if (require.main === module) {
  run()
    .then(() => {
      db.close();
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      db.close();
      process.exit(1);
    });
}

module.exports = { run };
