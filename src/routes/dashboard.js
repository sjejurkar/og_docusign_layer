const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const db = require('../db/client');
const { dashboardAuth } = require('../middleware/apiKeyAuth');

// Apply dashboard auth to all routes
router.use(dashboardAuth);

/**
 * GET /dashboard
 * Main dashboard view with job listing and KPIs
 */
router.get('/', async (req, res, next) => {
  try {
    const { status, from, to, jobId } = req.query;
    const apiKey = req.apiKey;

    // Get status counts for KPI cards
    const counts = await getStatusCounts();

    // Build filter conditions
    let whereClause = '1=1';
    const params = [];

    if (status) {
      whereClause += ' AND status = ?';
      params.push(status.toUpperCase());
    }

    if (from) {
      whereClause += ' AND DATE(created_at) >= ?';
      params.push(from);
    }

    if (to) {
      whereClause += ' AND DATE(created_at) <= ?';
      params.push(to);
    }

    // Get jobs
    const jobs = await db.query(
      `SELECT * FROM envelopes WHERE ${whereClause} ORDER BY created_at DESC LIMIT 100`,
      params
    );

    // Get selected job details if requested
    let selectedJob = null;
    let events = [];
    let errors = [];

    if (jobId) {
      selectedJob = await db.getOne('SELECT * FROM envelopes WHERE id = ?', [jobId]);
      if (selectedJob) {
        events = await db.query(
          'SELECT * FROM events WHERE job_id = ? ORDER BY created_at ASC',
          [jobId]
        );
        errors = await db.query(
          'SELECT * FROM errors WHERE job_id = ? ORDER BY created_at DESC',
          [jobId]
        );
      }
    }

    // Render dashboard HTML
    const html = renderDashboard({
      counts,
      jobs,
      selectedJob,
      events,
      errors,
      filters: { status, from, to },
      apiKey
    });

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    next(error);
  }
});

/**
 * Get counts by status for KPI cards
 */
async function getStatusCounts() {
  const result = await db.query(`
    SELECT status, COUNT(*) as count
    FROM envelopes
    GROUP BY status
  `);

  const counts = {
    SENT: 0,
    DELIVERED: 0,
    COMPLETED: 0,
    DECLINED: 0,
    VOIDED: 0,
    PUSH_FAILED: 0,
    ERROR: 0,
    total: 0
  };

  for (const row of result) {
    counts[row.status] = row.count;
    counts.total += row.count;
  }

  return counts;
}

/**
 * Render dashboard HTML
 */
function renderDashboard(data) {
  const { counts, jobs, selectedJob, events, errors, filters, apiKey } = data;

  const statusColors = {
    SENT: '#3498db',
    DELIVERED: '#9b59b6',
    COMPLETED: '#27ae60',
    DECLINED: '#e74c3c',
    VOIDED: '#95a5a6',
    PUSH_FAILED: '#f39c12',
    ERROR: '#c0392b',
    PENDING: '#bdc3c7'
  };

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="30">
  <title>DocuSign Integration Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #f5f6fa;
      color: #2c3e50;
      line-height: 1.6;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    header {
      background: #2c3e50;
      color: white;
      padding: 20px;
      margin-bottom: 20px;
    }
    header h1 { font-size: 24px; font-weight: 500; }
    header .subtitle { font-size: 14px; opacity: 0.8; margin-top: 5px; }

    /* KPI Cards */
    .kpi-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }
    .kpi-card {
      background: white;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .kpi-card .count {
      font-size: 32px;
      font-weight: bold;
      margin-bottom: 5px;
    }
    .kpi-card .label {
      font-size: 12px;
      text-transform: uppercase;
      color: #666;
    }

    /* Filters */
    .filters {
      background: white;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .filters form {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .filters select, .filters input[type="date"] {
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }
    .filters button {
      background: #3498db;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    .filters button:hover { background: #2980b9; }
    .filters a {
      color: #666;
      text-decoration: none;
      font-size: 14px;
      margin-left: 10px;
    }

    /* Job List */
    .job-list {
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .job-list table {
      width: 100%;
      border-collapse: collapse;
    }
    .job-list th, .job-list td {
      padding: 12px 15px;
      text-align: left;
      border-bottom: 1px solid #eee;
    }
    .job-list th {
      background: #f8f9fa;
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      color: #666;
    }
    .job-list tr:hover { background: #f8f9fa; }
    .job-list .job-id {
      font-family: monospace;
      font-size: 12px;
      color: #666;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: white;
    }
    .job-list a { color: #3498db; text-decoration: none; }
    .job-list a:hover { text-decoration: underline; }

    /* Job Detail */
    .job-detail {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .job-detail h2 {
      font-size: 18px;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 1px solid #eee;
    }
    .job-detail .close {
      float: right;
      color: #666;
      text-decoration: none;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }
    .detail-field label {
      display: block;
      font-size: 11px;
      text-transform: uppercase;
      color: #666;
      margin-bottom: 3px;
    }
    .detail-field .value {
      font-size: 14px;
      word-break: break-all;
    }

    /* Timeline */
    .timeline {
      border-left: 2px solid #eee;
      padding-left: 20px;
      margin: 20px 0;
    }
    .timeline-item {
      position: relative;
      padding-bottom: 15px;
    }
    .timeline-item::before {
      content: '';
      position: absolute;
      left: -26px;
      top: 5px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #3498db;
    }
    .timeline-item .time {
      font-size: 12px;
      color: #666;
    }
    .timeline-item .type {
      font-weight: 600;
      margin-left: 10px;
    }

    /* Errors */
    .error-list {
      background: #fff5f5;
      border: 1px solid #fed7d7;
      border-radius: 4px;
      padding: 15px;
      margin-top: 15px;
    }
    .error-list h3 {
      color: #c53030;
      font-size: 14px;
      margin-bottom: 10px;
    }
    .error-item {
      padding: 10px;
      background: white;
      border-radius: 4px;
      margin-bottom: 8px;
      font-size: 13px;
    }
    .error-item .type { font-weight: 600; color: #c53030; }

    /* Retry Button */
    .retry-form { margin-top: 15px; }
    .retry-btn {
      background: #f39c12;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    .retry-btn:hover { background: #e67e22; }

    /* Empty State */
    .empty-state {
      text-align: center;
      padding: 40px;
      color: #666;
    }

    @media (max-width: 768px) {
      .job-list { overflow-x: auto; }
      .job-list table { min-width: 700px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <h1>DocuSign Integration Dashboard</h1>
      <div class="subtitle">Auto-refreshes every 30 seconds</div>
    </div>
  </header>

  <div class="container">
    <!-- KPI Cards -->
    <div class="kpi-cards">
      <div class="kpi-card">
        <div class="count" style="color: ${statusColors.SENT}">${counts.SENT}</div>
        <div class="label">Sent</div>
      </div>
      <div class="kpi-card">
        <div class="count" style="color: ${statusColors.DELIVERED}">${counts.DELIVERED}</div>
        <div class="label">Delivered</div>
      </div>
      <div class="kpi-card">
        <div class="count" style="color: ${statusColors.COMPLETED}">${counts.COMPLETED}</div>
        <div class="label">Completed</div>
      </div>
      <div class="kpi-card">
        <div class="count" style="color: ${statusColors.DECLINED}">${counts.DECLINED}</div>
        <div class="label">Declined</div>
      </div>
      <div class="kpi-card">
        <div class="count" style="color: ${statusColors.PUSH_FAILED}">${counts.PUSH_FAILED}</div>
        <div class="label">Push Failed</div>
      </div>
      <div class="kpi-card">
        <div class="count" style="color: ${statusColors.ERROR}">${counts.ERROR}</div>
        <div class="label">Errors</div>
      </div>
      <div class="kpi-card">
        <div class="count">${counts.total}</div>
        <div class="label">Total</div>
      </div>
    </div>

    <!-- Filters -->
    <div class="filters">
      <form method="GET">
        <input type="hidden" name="api_key" value="${escapeHtml(apiKey)}">
        <select name="status">
          <option value="">All Statuses</option>
          ${['SENT', 'DELIVERED', 'COMPLETED', 'DECLINED', 'VOIDED', 'PUSH_FAILED', 'ERROR'].map(s =>
            `<option value="${s}" ${filters.status === s ? 'selected' : ''}>${s}</option>`
          ).join('')}
        </select>
        <input type="date" name="from" placeholder="From" value="${filters.from || ''}">
        <input type="date" name="to" placeholder="To" value="${filters.to || ''}">
        <button type="submit">Filter</button>
        <a href="/dashboard?api_key=${encodeURIComponent(apiKey)}">Clear</a>
      </form>
    </div>

    ${selectedJob ? renderJobDetail(selectedJob, events, errors, apiKey) : ''}

    <!-- Job List -->
    <div class="job-list">
      ${jobs.length > 0 ? `
      <table>
        <thead>
          <tr>
            <th>Job ID</th>
            <th>Envelope ID</th>
            <th>Customer</th>
            <th>Status</th>
            <th>Created</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${jobs.map(job => `
          <tr>
            <td class="job-id">${escapeHtml(job.id.substring(0, 8))}...</td>
            <td class="job-id">${job.envelope_id ? escapeHtml(job.envelope_id.substring(0, 8)) + '...' : '-'}</td>
            <td>${escapeHtml(job.customer_name)}</td>
            <td>
              <span class="status-badge" style="background: ${statusColors[job.status] || '#999'}">
                ${escapeHtml(job.status)}
              </span>
            </td>
            <td>${formatDate(job.created_at)}</td>
            <td>${formatDate(job.updated_at)}</td>
            <td>
              <a href="/dashboard?api_key=${encodeURIComponent(apiKey)}&jobId=${encodeURIComponent(job.id)}">View</a>
            </td>
          </tr>
          `).join('')}
        </tbody>
      </table>
      ` : `
      <div class="empty-state">
        <p>No envelopes found</p>
      </div>
      `}
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Render job detail section
 */
function renderJobDetail(job, events, errors, apiKey) {
  const statusColors = {
    SENT: '#3498db',
    DELIVERED: '#9b59b6',
    COMPLETED: '#27ae60',
    DECLINED: '#e74c3c',
    VOIDED: '#95a5a6',
    PUSH_FAILED: '#f39c12',
    ERROR: '#c0392b'
  };

  return `
    <div class="job-detail">
      <h2>
        Job Details
        <a href="/dashboard?api_key=${encodeURIComponent(apiKey)}" class="close">Close</a>
      </h2>
      <div class="detail-grid">
        <div class="detail-field">
          <label>Job ID</label>
          <div class="value">${escapeHtml(job.id)}</div>
        </div>
        <div class="detail-field">
          <label>Envelope ID</label>
          <div class="value">${escapeHtml(job.envelope_id || '-')}</div>
        </div>
        <div class="detail-field">
          <label>Status</label>
          <div class="value">
            <span class="status-badge" style="background: ${statusColors[job.status] || '#999'}">
              ${escapeHtml(job.status)}
            </span>
          </div>
        </div>
        <div class="detail-field">
          <label>Customer Name</label>
          <div class="value">${escapeHtml(job.customer_name)}</div>
        </div>
        <div class="detail-field">
          <label>Customer Email</label>
          <div class="value">${escapeHtml(job.customer_email)}</div>
        </div>
        <div class="detail-field">
          <label>Created</label>
          <div class="value">${formatDate(job.created_at)}</div>
        </div>
        <div class="detail-field">
          <label>Last Updated</label>
          <div class="value">${formatDate(job.updated_at)}</div>
        </div>
        ${job.document_path ? `
        <div class="detail-field">
          <label>Document</label>
          <div class="value">
            <a href="/api/v1/envelopes/${encodeURIComponent(job.id)}/document" target="_blank">Download PDF</a>
          </div>
        </div>
        ` : ''}
      </div>

      <h3>Event Timeline</h3>
      <div class="timeline">
        ${events.length > 0 ? events.map(event => `
          <div class="timeline-item">
            <span class="time">${formatDate(event.created_at)}</span>
            <span class="type">${escapeHtml(event.event_type)}</span>
          </div>
        `).join('') : '<p>No events recorded</p>'}
      </div>

      ${errors.length > 0 ? `
      <div class="error-list">
        <h3>Errors</h3>
        ${errors.map(error => `
          <div class="error-item">
            <span class="type">${escapeHtml(error.error_type)}</span>
            <p>${escapeHtml(error.message)}</p>
            <small>${formatDate(error.created_at)}</small>
          </div>
        `).join('')}
      </div>
      ` : ''}

      ${job.status === 'PUSH_FAILED' ? `
      <form class="retry-form" method="POST" action="/api/v1/envelopes/${encodeURIComponent(job.id)}/retry">
        <input type="hidden" name="api_key" value="${escapeHtml(apiKey)}">
        <button type="submit" class="retry-btn">Retry Downstream Push</button>
      </form>
      ` : ''}
    </div>
  `;
}

/**
 * Format date for display
 */
function formatDate(dateStr) {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str || '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = router;
