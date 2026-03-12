let supabase = null;

/**
 * Initialize database connection (Supabase only)
 */
async function initialize(config) {
  if (supabase) return supabase;

  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false }
  });

  // Test connection
  const { error } = await supabase.from('envelopes').select('id').limit(1);
  if (error && !error.message.includes('0 rows')) {
    throw new Error(`Supabase connection failed: ${error.message}`);
  }
  return supabase;
}

/**
 * Parse SQL and execute via Supabase query builder
 */
async function executeSupabaseQuery(sql, params = []) {
  const sqlLower = sql.toLowerCase().trim();

  // INSERT
  if (sqlLower.startsWith('insert into')) {
    return handleInsert(sql, params);
  }

  // UPDATE
  if (sqlLower.startsWith('update')) {
    return handleUpdate(sql, params);
  }

  // SELECT with COUNT
  if (sqlLower.includes('count(*)')) {
    return handleCount(sql, params);
  }

  // SELECT
  if (sqlLower.startsWith('select')) {
    return handleSelect(sql, params);
  }

  throw new Error(`Unsupported SQL query: ${sql}`);
}

/**
 * Handle INSERT statements
 */
async function handleInsert(sql, params) {
  const match = sql.match(/insert into (\w+)\s*\(([^)]+)\)/i);
  if (!match) throw new Error(`Cannot parse INSERT: ${sql}`);

  const table = match[1];
  const columns = match[2].split(',').map(c => c.trim());

  const data = {};
  columns.forEach((col, i) => {
    let value = params[i];
    // Handle CURRENT_TIMESTAMP
    if (sql.toLowerCase().includes('current_timestamp') && value === undefined) {
      value = new Date().toISOString();
    }
    data[col] = value;
  });

  const { error } = await supabase.from(table).insert(data);
  if (error) throw new Error(`Insert failed: ${error.message}`);
  return { changes: 1 };
}

/**
 * Handle UPDATE statements
 */
async function handleUpdate(sql, params) {
  const match = sql.match(/update (\w+) set (.+) where (.+)/i);
  if (!match) throw new Error(`Cannot parse UPDATE: ${sql}`);

  const table = match[1];
  const setClause = match[2];
  const whereClause = match[3];

  // Parse SET clause
  const setParts = setClause.split(',').map(s => s.trim());
  const data = {};
  let paramIndex = 0;

  for (const part of setParts) {
    const [col, val] = part.split('=').map(s => s.trim());
    if (val === '?') {
      data[col] = params[paramIndex++];
    } else if (val.toLowerCase() === 'current_timestamp') {
      data[col] = new Date().toISOString();
    }
  }

  // Parse WHERE clause (simple id = ? pattern)
  const whereMatch = whereClause.match(/(\w+)\s*=\s*\?/i);
  if (!whereMatch) throw new Error(`Cannot parse WHERE: ${whereClause}`);

  const whereCol = whereMatch[1];
  const whereVal = params[paramIndex];

  const { error } = await supabase.from(table).update(data).eq(whereCol, whereVal);
  if (error) throw new Error(`Update failed: ${error.message}`);
  return { changes: 1 };
}

/**
 * Handle SELECT statements
 */
async function handleSelect(sql, params) {
  const match = sql.match(/select (.+?) from (\w+)(.*)/i);
  if (!match) throw new Error(`Cannot parse SELECT: ${sql}`);

  const columns = match[1].trim();
  const table = match[2];
  const rest = match[3] || '';

  let query = supabase.from(table);

  // Handle column selection
  if (columns !== '*') {
    query = query.select(columns.split(',').map(c => c.trim()).join(','));
  } else {
    query = query.select('*');
  }

  // Parse WHERE clauses
  let paramIndex = 0;
  const whereMatch = rest.match(/where\s+(.+?)(?:\s+order|\s+limit|\s*$)/i);

  if (whereMatch) {
    const conditions = whereMatch[1];

    // Handle various conditions
    const condParts = conditions.split(/\s+and\s+/i);
    for (const cond of condParts) {
      if (cond.trim() === '1=1') continue;

      const eqMatch = cond.match(/(\w+)\s*=\s*\?/i);
      const gteMatch = cond.match(/(\w+)\s*>=\s*\?/i);
      const lteMatch = cond.match(/(\w+)\s*<=\s*\?/i);

      if (eqMatch) {
        query = query.eq(eqMatch[1], params[paramIndex++]);
      } else if (gteMatch) {
        query = query.gte(gteMatch[1], params[paramIndex++]);
      } else if (lteMatch) {
        query = query.lte(lteMatch[1], params[paramIndex++]);
      }
    }
  }

  // Handle ORDER BY
  const orderMatch = rest.match(/order by (\w+)\s*(asc|desc)?/i);
  if (orderMatch) {
    const ascending = (orderMatch[2] || 'asc').toLowerCase() === 'asc';
    query = query.order(orderMatch[1], { ascending });
  }

  // Handle LIMIT and OFFSET
  const limitMatch = rest.match(/limit\s+(\d+|\?)/i);
  const offsetMatch = rest.match(/offset\s+(\d+|\?)/i);

  let limit = null, offset = null;
  if (limitMatch) {
    limit = limitMatch[1] === '?' ? params[paramIndex++] : parseInt(limitMatch[1]);
  }
  if (offsetMatch) {
    offset = offsetMatch[1] === '?' ? params[paramIndex++] : parseInt(offsetMatch[1]);
  }

  if (limit !== null && offset !== null) {
    query = query.range(offset, offset + limit - 1);
  } else if (limit !== null) {
    query = query.limit(limit);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Select failed: ${error.message}`);
  return data || [];
}

/**
 * Handle COUNT queries
 */
async function handleCount(sql, params) {
  const match = sql.match(/from (\w+)(.*)/i);
  if (!match) throw new Error(`Cannot parse COUNT: ${sql}`);

  const table = match[1];
  const rest = match[2] || '';

  let query = supabase.from(table).select('*', { count: 'exact', head: true });

  // Parse WHERE clauses
  let paramIndex = 0;
  const whereMatch = rest.match(/where\s+(.+?)$/i);

  if (whereMatch) {
    const conditions = whereMatch[1];
    const condParts = conditions.split(/\s+and\s+/i);

    for (const cond of condParts) {
      if (cond.trim() === '1=1') continue;

      const eqMatch = cond.match(/(\w+)\s*=\s*\?/i);
      const gteMatch = cond.match(/(\w+)\s*>=\s*\?/i);
      const lteMatch = cond.match(/(\w+)\s*<=\s*\?/i);

      if (eqMatch) {
        query = query.eq(eqMatch[1], params[paramIndex++]);
      } else if (gteMatch) {
        query = query.gte(gteMatch[1], params[paramIndex++]);
      } else if (lteMatch) {
        query = query.lte(lteMatch[1], params[paramIndex++]);
      }
    }
  }

  const { count, error } = await query;
  if (error) throw new Error(`Count failed: ${error.message}`);
  return [{ count: count || 0 }];
}

/**
 * Execute a query that returns rows (SELECT)
 */
async function query(sql, params = []) {
  if (!supabase) throw new Error('Database not initialized');
  return executeSupabaseQuery(sql, params);
}

/**
 * Execute a query that modifies data (INSERT, UPDATE, DELETE)
 */
async function run(sql, params = []) {
  if (!supabase) throw new Error('Database not initialized');
  return executeSupabaseQuery(sql, params);
}

/**
 * Get a single row
 */
async function getOne(sql, params = []) {
  if (!supabase) throw new Error('Database not initialized');
  const results = await executeSupabaseQuery(sql, params);
  return results[0] || null;
}

/**
 * Get multiple rows (alias for query)
 */
async function getMany(sql, params = []) {
  return query(sql, params);
}

/**
 * Close database connection
 */
async function close() {
  supabase = null;
}

/**
 * Get raw database instance
 */
function getDb() {
  return supabase;
}

module.exports = {
  initialize,
  query,
  run,
  getOne,
  getMany,
  close,
  getDb
};
