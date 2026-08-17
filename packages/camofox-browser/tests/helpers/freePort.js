import net from 'node:net';

/**
 * Reserve a port the OS says is free.
 *
 * The suites used to pick `3100 + random(900)` and immediately poll `/health` on it.
 * When a previous server on that port was still shutting down, the poll answered
 * from the dying process while the new one failed to bind — the test then hit a
 * reset connection (ECONNRESET) on its first real request. Asking the OS for an
 * ephemeral port and releasing it right before launch removes the collision.
 *
 * There is still a theoretical window between close() and the server binding, but
 * the OS does not hand the same ephemeral port out twice in a row, so it is orders
 * of magnitude tighter than a 900-wide random draw.
 */
export function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
