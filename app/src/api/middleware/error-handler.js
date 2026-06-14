function errorHandler(err, req, res, next) {
  const requestId = req.requestId;
  const status = err.statusCode || err.status || 500;

  if (process.env.NODE_ENV !== 'test') {
    // Full error details go server-side only — never expose stack traces or internal IDs to callers.
    process.stderr.write(JSON.stringify({
      requestId,
      status,
      actorId: req.actor?.id,
      actorRole: req.actor?.role,
      message: err.message,
      stack: err.stack
    }) + '\n');
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      requestId,
      error: 'Validation failed',
      details: Object.values(err.errors).map(e => e.message)
    });
  }

  if (err.code === 11000) {
    return res.status(409).json({ requestId, error: 'Duplicate entry' });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ requestId, error: 'Invalid identifier format' });
  }

  // For 5xx errors return a generic message; for 4xx return the operational message
  // (state machine errors, not-found etc. — none of which contain PHI).
  const clientMessage = status >= 500 ? 'An internal error occurred' : err.message;
  res.status(status).json({ requestId, error: clientMessage });
}

module.exports = errorHandler;
