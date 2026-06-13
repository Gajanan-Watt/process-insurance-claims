module.exports = async () => {
  if (global.__REPLSET__) {
    await global.__REPLSET__.stop();
  }
};
