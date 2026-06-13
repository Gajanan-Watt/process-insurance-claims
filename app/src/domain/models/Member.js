const mongoose = require('mongoose');

const memberSchema = new mongoose.Schema({
  name: { type: String, required: true },
  dateOfBirth: { type: Date, required: true },
  memberId: { type: String, required: true, unique: true },
  policyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Policy' }
}, { timestamps: true });

module.exports = mongoose.model('Member', memberSchema);
