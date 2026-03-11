const { logger } = require('./logger');

/**
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a function with exponential backoff retry logic
 *
 * @param {Function} fn - Async function to execute. Receives attempt number (0-indexed)
 * @param {Object} options - Configuration options
 * @param {number} options.retries - Number of retry attempts (default: 3)
 * @param {number[]} options.delays - Delay in ms for each retry (default: [1000, 5000, 15000])
 * @param {Function} options.shouldRetry - Function to determine if error is retryable (default: always retry)
 * @param {Object} options.context - Context object for logging
 * @returns {Promise<any>} - Result from successful execution
 * @throws {Error} - Last error after all retries exhausted
 */
async function withRetry(fn, options = {}) {
  const {
    retries = 3,
    delays = [1000, 5000, 15000],
    shouldRetry = () => true,
    context = {}
  } = options;

  let lastError;
  const log = logger.child(context);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fn(attempt);
      return result;
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (!shouldRetry(error)) {
        log.warn({ attempt, error: error.message }, 'Non-retryable error encountered');
        throw error;
      }

      // Check if we have retries left
      if (attempt >= retries) {
        log.error(
          { attempt, error: error.message, totalAttempts: retries + 1 },
          'All retry attempts exhausted'
        );
        break;
      }

      // Calculate delay for next attempt
      const delay = delays[attempt] || delays[delays.length - 1];

      log.warn(
        { attempt, error: error.message, nextRetryIn: delay },
        'Attempt failed, retrying...'
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Create a retryable wrapper around an async function
 *
 * @param {Function} fn - Async function to wrap
 * @param {Object} options - Retry options (same as withRetry)
 * @returns {Function} - Wrapped function with retry logic
 */
function retryable(fn, options = {}) {
  return async (...args) => {
    return withRetry(() => fn(...args), options);
  };
}

/**
 * Check if an HTTP error is retryable
 * Retryable: 5xx errors, network errors, timeout errors
 * Not retryable: 4xx errors (except 429 Too Many Requests)
 */
function isRetryableHttpError(error) {
  // Network errors
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true;
  }

  // Axios response errors
  if (error.response) {
    const status = error.response.status;
    // Retry 5xx errors and 429 (rate limit)
    return status >= 500 || status === 429;
  }

  // Axios request errors (no response received)
  if (error.request && !error.response) {
    return true;
  }

  // Default: don't retry unknown errors
  return false;
}

module.exports = {
  sleep,
  withRetry,
  retryable,
  isRetryableHttpError
};
