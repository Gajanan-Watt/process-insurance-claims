function errorHandler(err, req, res, next) {
  const status = err.statusCode || err.status || 500;
  const message = err.message || 'Internal server error';

  if (process.env.NODE_ENV !== 'test') {
    console.error(`[${status}] ${message}`, err.stack);
  }

  // Mongoose validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: Object.values(err.errors).map(e => e.message)
    });
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    return res.status(409).json({ error: 'Duplicate entry', details: err.keyValue });
  }

  res.status(status).json({ error: message });
}

module.exports = errorHandler;
