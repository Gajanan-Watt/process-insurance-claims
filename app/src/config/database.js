const mongoose = require('mongoose');

async function connect(uri) {
  const target = uri || process.env.MONGODB_URI || 'mongodb://localhost:27017/insurance-claims';
  await mongoose.connect(target);
}

async function disconnect() {
  await mongoose.disconnect();
}

module.exports = { connect, disconnect };
