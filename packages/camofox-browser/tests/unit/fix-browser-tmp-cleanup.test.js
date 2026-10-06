/**
 * PHI-VENDOR regression tests: cleanupStaleFirefoxProfiles() must not delete
 * Firefox/Camoufox temp profiles created by other tools sharing the system
 * temp dir, only the ones created by a camofox-browser process.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { cleanupStaleFirefoxProfiles } from '../../lib/tmp-cleanup.js';

const OLD = 5 * 60 * 1000;

function age(dir) {
  const t = new Date(Date.now() - OLD);
  fs.utimesSync(dir, t, t);
}

describe('cleanupStaleFirefoxProfiles ownership (system temp dir)', () => {
  const created = [];
  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a stale profile created by another tool (no owner marker)', () => {
    // Simulate a foreign Playwright profile: created without going through
    // the tracked mkdtemp (plain mkdirSync with a random suffix).
    const foreign = path.join(os.tmpdir(), `playwright_firefoxdev_profile-fixbrowser${process.pid}${Date.now()}`);
    fs.mkdirSync(foreign);
    created.push(foreign);
    age(foreign);

    cleanupStaleFirefoxProfiles();
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it('removes a stale profile created by this process via mkdtemp', async () => {
    const own = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'playwright_firefoxdev_profile-'));
    created.push(own);
    expect(fs.readFileSync(path.join(own, '.camofox-browser-owner'), 'utf8')).toBe(String(process.pid));
    age(own);

    cleanupStaleFirefoxProfiles();
    expect(fs.existsSync(own)).toBe(false);
  });

  it('removes leftovers of a dead camofox-browser process but keeps a live owner', () => {
    const dead = path.join(os.tmpdir(), `camoufox-fixbrowser-dead-${process.pid}-${Date.now()}`);
    const alive = path.join(os.tmpdir(), `camoufox-fixbrowser-alive-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dead);
    fs.mkdirSync(alive);
    created.push(dead, alive);
    // Far above any real pid_max: no such process exists.
    fs.writeFileSync(path.join(dead, '.camofox-browser-owner'), '2147483646');
    // The parent process is alive and is not us: its profiles must survive.
    fs.writeFileSync(path.join(alive, '.camofox-browser-owner'), String(process.ppid));
    age(dead);
    age(alive);

    cleanupStaleFirefoxProfiles();
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(alive)).toBe(true);
  });
});
