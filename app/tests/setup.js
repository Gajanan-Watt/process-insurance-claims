const { MongoMemoryReplSet } = require('mongodb-memory-server');

module.exports = async () => {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  await replSet.waitUntilRunning();
  process.env.MONGODB_URI = replSet.getUri();
  global.__REPLSET__ = replSet;
};
