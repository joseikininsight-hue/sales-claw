'use strict';

const net = require('net');

async function isPortAvailable(port, host) {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });

    tester.listen(port, host);
  });
}

async function findAvailablePort(preferredPort, host, maxAttempts = 20) {
  const basePort = Number.isInteger(preferredPort) && preferredPort > 0 ? preferredPort : 3765;

  for (let candidate = basePort; candidate < basePort + maxAttempts; candidate += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(candidate, host)) return candidate;
  }

  return 0;
}

module.exports = {
  findAvailablePort,
  isPortAvailable,
};
