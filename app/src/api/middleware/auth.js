const jwt = require('jsonwebtoken');

const VALID_ROLES = ['MEMBER', 'ADJUSTER', 'ADMIN', 'AUDITOR'];

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!VALID_ROLES.includes(payload.role)) {
      return res.status(401).json({ error: 'Invalid token claims' });
    }
    req.actor = { id: payload.sub, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.actor?.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// MEMBER callers may only access resources belonging to themselves.
// Elevated roles (ADJUSTER, ADMIN, AUDITOR) bypass the check.
function requireOwnerOrElevated(getResourceMemberId) {
  return async (req, res, next) => {
    try {
      if (req.actor.role !== 'MEMBER') return next();
      const ownerId = await getResourceMemberId(req);
      if (!ownerId || ownerId.toString() !== req.actor.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireAuth, requireRole, requireOwnerOrElevated };
