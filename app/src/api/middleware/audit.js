const { randomUUID } = require('crypto');
const AuditLog = require('../../domain/models/AuditLog');

// Attaches a requestId to every request and writes an AuditLog entry after
// the response finishes. Unauthenticated requests are logged as 'anonymous'
// so failed auth attempts are also captured.
module.exports = function auditMiddleware(req, res, next) {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);

  res.on('finish', () => {
    AuditLog.create({
      requestId: req.requestId,
      actorId: req.actor?.id ?? 'anonymous',
      actorRole: req.actor?.role ?? 'none',
      action: `${req.method} ${req.route?.path ?? req.path}`,
      resourceType: req.baseUrl?.replace('/', '').toUpperCase() || null,
      resourceId: req.params?.id ?? null,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      statusCode: res.statusCode
    }).catch(err => {
      // Audit failures must never crash a request, but must be surfaced.
      process.stderr.write(
        `[AUDIT_FAILURE] requestId=${req.requestId} err=${err.message}\n`
      );
    });
  });

  next();
};
