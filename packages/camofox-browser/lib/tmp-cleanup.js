import fs from 'fs';
import path from 'path';
import os from 'os';

const ORPHAN_PATTERNS = [
  /^\.fea5[a-f0-9]+\.so$/,
  /^\.5ef7[a-f0-9]+\.node$/,
];

// Firefox temp profile directories created by Playwright/Camoufox
const FIREFOX_PROFILE_PATTERN = /^playwright_firefoxdev_profile-/;
// Camoufox also creates these
const CAMOUFOX_TMP_PATTERN = /^camoufox[-_]/;

// PHI-VENDOR: the system temp dir is shared with every other Playwright /
// Camoufox user on the machine (test runners, other agents, a second phi
// session). Only directories created by a camofox-browser process may be
// removed there. Playwright creates its Firefox profile with fs.promises.mkdtemp
// in this very process, so we record every matching temp dir created here and
// drop an owner marker (with our pid) inside it. On the next start, leftovers
// of a crashed camofox-browser are still recognised through that marker, while
// a dir whose owner process is still alive is never touched.
const OWNER_MARKER = '.camofox-browser-owner';
const ownedTempDirs = new Set();

function isProfileDirName(name) {
  return FIREFOX_PROFILE_PATTERN.test(name) || CAMOUFOX_TMP_PATTERN.test(name);
}

function claimTempDir(dirPath) {
  if (typeof dirPath !== 'string' || !isProfileDirName(path.basename(dirPath))) return;
  ownedTempDirs.add(path.resolve(dirPath));
  try {
    fs.writeFileSync(path.join(dirPath, OWNER_MARKER), String(process.pid), { mode: 0o600 });
  } catch {
    // marker is only needed for crash recovery; in-process tracking still works
  }
}

function installMkdtempTracking() {
  const flag = Symbol.for('camofox-browser.mkdtempTracking');
  if (fs[flag]) return;
  fs[flag] = true;
  const originalSync = fs.mkdtempSync;
  fs.mkdtempSync = function mkdtempSyncTracked(...args) {
    const dir = originalSync.apply(this, args);
    claimTempDir(dir);
    return dir;
  };
  const originalAsync = fs.promises.mkdtemp;
  fs.promises.mkdtemp = async function mkdtempTracked(...args) {
    const dir = await originalAsync.apply(this, args);
    claimTempDir(dir);
    return dir;
  };
}

installMkdtempTracking();

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else
    return err?.code === 'EPERM';
  }
}

/** True when `full` was created by this process or by a camofox-browser process that is gone. */
function isOwnedProfileDir(full) {
  if (ownedTempDirs.has(path.resolve(full))) return true;
  let pid;
  try {
    pid = Number.parseInt(fs.readFileSync(path.join(full, OWNER_MARKER), 'utf8'), 10);
  } catch {
    return false; // no marker: created by another tool
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return pid === process.pid || !isProcessAlive(pid);
}

export function cleanupOrphanedTempFiles({ tmpDir, minAgeMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  const result = { scanned: 0, removed: 0, bytes: 0, skipped: 0 };
  if (!tmpDir) return result;

  let entries;
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return result;
  }

  for (const name of entries) {
    if (!ORPHAN_PATTERNS.some((re) => re.test(name))) continue;
    result.scanned++;
    const full = path.join(tmpDir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs < minAgeMs) {
        result.skipped++;
        continue;
      }
      fs.unlinkSync(full);
      result.removed++;
      result.bytes += st.size;
    } catch {
      // file vanished, permission denied, or race with another process - skip silently
    }
  }

  return result;
}

/**
 * Clean up stale Firefox/Camoufox temp profile directories.
 * These accumulate when browser.close() doesn't fully clean up
 * (especially with enable_cache: true). Each profile can be 10-100MB+.
 *
 * Only removes profiles older than minAgeMs (default 2 minutes)
 * to avoid killing profiles belonging to an actively launching browser.
 *
 * PHI-VENDOR: when scanning the shared system temp dir (no `tmpDir`, the
 * server's only call shape), only dirs owned by camofox-browser are removed
 * (see isOwnedProfileDir). An explicit `tmpDir` is a directory dedicated to
 * the caller, where every matching dir is fair game (`onlyOwned` overrides).
 */
export function cleanupStaleFirefoxProfiles({ tmpDir, minAgeMs = 2 * 60 * 1000, now = Date.now(), onlyOwned = !tmpDir } = {}) {
  const dir = tmpDir || os.tmpdir();
  const result = { scanned: 0, removed: 0, bytes: 0, skipped: 0 };

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return result;
  }

  for (const name of entries) {
    if (!FIREFOX_PROFILE_PATTERN.test(name) && !CAMOUFOX_TMP_PATTERN.test(name)) continue;
    result.scanned++;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isDirectory()) continue;
      if (onlyOwned && !isOwnedProfileDir(full)) {
        result.skipped++;
        continue;
      }
      if (now - st.mtimeMs < minAgeMs) {
        result.skipped++;
        continue;
      }
      // Calculate directory size before removing
      const dirBytes = _dirSizeSync(full);
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 });
      ownedTempDirs.delete(path.resolve(full));
      result.removed++;
      result.bytes += dirBytes;
    } catch {
      // directory vanished, permission denied, or in-use -- skip
    }
  }

  return result;
}

/** Recursively calculate directory size (best effort, fast). */
function _dirSizeSync(dirPath) {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          total += _dirSizeSync(full);
        } else {
          total += fs.statSync(full).size;
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}
