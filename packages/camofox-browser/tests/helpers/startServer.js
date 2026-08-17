import path from 'path';
import { fileURLToPath } from 'node:url';
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';
import { reserveFreePort } from './freePort.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let serverProcess = null;
let serverPort = null;

async function waitForServer(port, maxRetries = 30, interval = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) {
        return true;
      }
    } catch (e) {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Server failed to start on port ${port} after ${maxRetries} attempts`);
}

async function startServer(port = 0, extraEnv = {}) {
  const usePort = port || (await reserveFreePort());
  const cfg = loadConfig();
  const pluginDir = path.join(__dirname, '../..');

  const log = {
    info: (msg) => { if (cfg.serverEnv.DEBUG_SERVER) console.log(msg); },
    error: (msg) => { if (cfg.serverEnv.DEBUG_SERVER) console.error(msg); },
  };

  serverProcess = launchServer({
    pluginDir,
    port: usePort,
    // The suites drive a fixture site on localhost, which the server's SSRF guard
    // blocks by default (and rightly so). Opting in here — rather than weakening
    // the guard — keeps the shipped default secure.
    env: {
      ...cfg.serverEnv,
      DEBUG_RESPONSES: 'false',
      CAMOFOX_ALLOW_PRIVATE_HOSTS: '1',
      ...extraEnv,
    },
    log,
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err);
  });

  serverPort = usePort;

  await waitForServer(usePort);

  console.log(`camofox-browser server started on port ${usePort}`);
  return usePort;
}

/**
 * Stop the running server.
 *
 * The SIGKILL fallback used to be a timer that was never cleared and that read the
 * SHARED `serverProcess` binding. When the process closed quickly the timer stayed
 * pending, the next describe block started its own server into that same binding,
 * and ~5 s later the stale timer killed THAT server — the block's requests then
 * died on ECONNRESET. The timer now targets the process it was created for and is
 * cleared as soon as it closes.
 */
async function stopServer() {
  if (serverProcess) {
    return new Promise((resolve) => {
      const child = serverProcess;
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 5000);

      child.on('close', () => {
        clearTimeout(forceKill);
        if (serverProcess === child) {
          serverProcess = null;
          serverPort = null;
        }
        resolve();
      });

      child.kill('SIGTERM');
    });
  }
}

function getServerUrl() {
  if (!serverPort) throw new Error('Server not started');
  return `http://localhost:${serverPort}`;
}

function getServerPort() {
  return serverPort;
}

export {
  startServer,
  stopServer,
  getServerUrl,
  getServerPort
};
