const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const app = express();

// Restrict cross-origin requests to explicitly allowed origins.
// ALLOWED_ORIGINS is a comma-separated list; empty in production blocks all origins.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : (process.env.NODE_ENV === 'development' ? ['http://localhost:3000'] : []);

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : false,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Request-Id'],
  credentials: true,
  maxAge: 86400
}));

app.use(express.json());

// Wire up event bus subscribers — structured JSON to stdout so log aggregators can ingest them.
const eventBus = require('./domain/events/eventBus');
const EVENTS = require('./domain/events/events');

const LOGGED_EVENTS = [
  EVENTS.CLAIM_SUBMITTED,
  EVENTS.CLAIM_REVIEW_STARTED,
  EVENTS.CLAIM_ADJUDICATED,
  EVENTS.CLAIM_PAID,
  EVENTS.CLAIM_REPROCESSED,
  EVENTS.ITEM_DECISION_MADE,
  EVENTS.DECISION_SUPERSEDED,
  EVENTS.BENEFIT_LIMIT_CONSUMED,
  EVENTS.BENEFIT_LIMIT_RELEASED,
  EVENTS.BENEFIT_LIMIT_EXHAUSTED,
  EVENTS.DISPUTE_FILED,
  EVENTS.DISPUTE_RESOLVED
];

for (const event of LOGGED_EVENTS) {
  eventBus.on(event, (payload) => {
    process.stdout.write(JSON.stringify({ event, ...payload }) + '\n');
  });
}

// Global rate limit — tighter per-resource limits are applied in each route file.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
}));

// Attach requestId and write an audit log entry on every response finish.
// Must run before routes so req.requestId is available to error-handler.
app.use(require('./api/middleware/audit'));

app.use('/members', require('./api/routes/members'));
app.use('/policies', require('./api/routes/policies'));
app.use('/claims', require('./api/routes/claims'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use(require('./api/middleware/error-handler'));

module.exports = app;
