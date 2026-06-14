const EventEmitter = require('events');

const bus = new EventEmitter();
// Prevent spurious MaxListenersExceededWarning in test suites with many subscribers.
bus.setMaxListeners(50);

module.exports = bus;
