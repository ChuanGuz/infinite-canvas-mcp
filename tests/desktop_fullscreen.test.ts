import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import type { Browser, CDPSession } from '@playwright/test';

test('minimal desktop title has no additional fullscreen controls', () => {
  const html = readFileSync(resolve('src/web/index.html'), 'utf8');
  const app = readFileSync(resolve('src/web/app.js'), 'utf8');
  assert.match(html, /<title>&#65279;<\/title>/);
  assert.ok(app.includes('document.title = "\\uFEFF"'));
  for (const text of [html, app])
    assert.doesNotMatch(text, /⛶ 真全屏|❐ 退出全屏|data-action="fullscreen"|#fullscreen-toggle/);
});

test('compiled native controller handles maximize, F11, Esc, repeat, focus and exact monitor coverage',
  { skip: process.platform !== 'win32', timeout: 60_000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-native-'));
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const exe = join(dir, 'FullscreenSmoke.exe');
    const compile = spawnSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
      ['-nologo', '-target:exe', '-platform:x64', '-reference:System.Windows.Forms.dll',
        '-reference:System.Drawing.dll', `-out:${exe}`, resolve('tests/desktop_fullscreen_smoke.cs')],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const profile = join(dir, 'profile');
    assert.ok(existsSync(chromium.executablePath()), 'Run npm run test:install to install the test browser');
    const child = spawn(exe, [resolve('无限画布.exe'), chromium.executablePath(), profile], { windowsHide: true });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += String(data); });
    child.stderr.on('data', data => { errors += String(data); });
    let browser: Browser | undefined, session: CDPSession | undefined, windowId = 0;
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve); child.once('error', reject);
    });
    const timeout = setTimeout(() => child.kill(), 50_000);
    t.after(async () => { clearTimeout(timeout); child.kill(); await browser?.close(); });
    for await (const line of createInterface({ input: child.stdout })) {
      try {
        if (line === 'BROWSER_READY') {
          const portFile = join(profile, 'DevToolsActivePort');
          for (let attempt = 0; !existsSync(portFile) && attempt < 100; attempt++) await delay(50);
          const port = readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
          browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
          const page = browser.contexts()[0]!.pages()[0]!;
          session = await page.context().newCDPSession(page);
          ({ windowId } = await session.send('Browser.getWindowForTarget'));
          child.stdin.write('OK\n');
        } else if (line === 'BROWSER_FULL' || line === 'BROWSER_NORMAL') {
          assert.ok(session);
          await session.send('Browser.setWindowBounds', { windowId,
            bounds: { windowState: line === 'BROWSER_FULL' ? 'fullscreen' : 'normal' } });
          child.stdin.write('OK\n');
        }
      } catch (error) { child.stdin.write('FAIL\n'); throw error; }
    }
    assert.equal(await exited, 0, output + errors);
    assert.match(output, /Native fullscreen checks passed/);
    assert.match(output, /Chromium app fullscreen checks passed/);
  });
