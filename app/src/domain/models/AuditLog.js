const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  requestId: { type: String, required: true },
  actorId: { type: String, required: true },
  actorRole: { type: String, required: true },
  action: { type: String, required: true },
  resourceType: { type: String, default: null },
  resourceId: { type: String, default: null },
  ip: { type: String },
  userAgent: { type: String },
  statusCode: { type: Number },
  timestamp: { type: Date, default: Date.now }
}, { timestamps: false });

auditLogSchema.index({ actorId: 1, timestamp: -1 });
auditLogSchema.index({ resourceType: 1, resourceId: 1, timestamp: -1 });
auditLogSchema.index({ timestamp: -1 });

// HIPAA requires 6 years; retain for 7.
auditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7 * 365 * 24 * 60 * 60 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
