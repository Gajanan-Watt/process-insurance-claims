const mongoose = require('mongoose');

const policySchema = new mongoose.Schema({
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
  planType: { type: String, required: true, enum: ['BASIC', 'STANDARD', 'PREMIUM'] },
  effectiveDate: { type: Date, required: true },
  terminationDate: { type: Date },
  status: { type: String, enum: ['ACTIVE', 'TERMINATED', 'SUSPENDED'], default: 'ACTIVE' }
}, { timestamps: true });

module.exports = mongoose.model('Policy', policySchema);
