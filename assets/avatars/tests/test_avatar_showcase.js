const http = require('http');
const fs = require('fs');
const path = require('path');
let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  try {
    puppeteer = require('/workspace/MobileGames/node_modules/puppeteer');
  } catch (e2) {
    puppeteer = require(path.resolve(__dirname, '../../../../MobileGames/node_modules/puppeteer'));
  }
}

const PORT = 8099;
const AVATARS_DIR = path.resolve(__dirname, '..');

// Simple static server for avatar testing
function createServer() {
  return http.createServer((req, res) => {
    let reqPath = req.url.split('?')[0];
    if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
    const filePath = path.join(AVATARS_DIR, reqPath);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found: ' + reqPath);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.png': 'image/png',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

const PERSONA_KEYS = ['atlas', 'alex', 'victor', 'marcus', 'tessa', 'riley', 'chloe'];

async function runBlackBoxValidation() {
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[QA Test Controller] Server listening on http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const metrics = [];
  const networkErrors = [];

  page.on('response', (response) => {
    if (response.status() >= 400) {
      networkErrors.push({ url: response.url(), status: response.status() });
    }
  });

  const pageLoadStart = Date.now();
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
  const pageLoadTime = Date.now() - pageLoadStart;
  console.log(`[QA Test Controller] Initial page load complete in ${pageLoadTime}ms`);

  // Verify page title and header
  const headerText = await page.$eval('h1', (el) => el.textContent);
  if (!headerText.includes('Autonomous Engineering Team')) {
    throw new Error(`Unexpected header text: ${headerText}`);
  }

  // Initial screenshot
  await page.screenshot({ path: path.join(AVATARS_DIR, 'evidence_overview.png') });
  console.log('[QA Test Controller] Captured evidence_overview.png');

  // Test each persona through purely black-box DOM clicks
  for (const role of PERSONA_KEYS) {
    const btnSelector = `#btn-persona-${role}`;
    await page.waitForSelector(btnSelector);

    const tStart = performance.now();
    await page.click(btnSelector);

    // Wait for DOM update & natural rendering
    await new Promise((r) => setTimeout(r, 100));

    const evalResult = await page.evaluate(async (roleKey) => {
      const img = document.getElementById('stage-avatar');
      const activeHudPersona = document.getElementById('hud-persona').textContent;
      const hudRes = document.getElementById('hud-resolution').textContent;
      const hudDisplay = document.getElementById('hud-displaysize').textContent;

      // Ensure image is fully loaded
      if (!img.complete) {
        await new Promise((res) => {
          img.onload = res;
        });
      }

      return {
        src: img.src,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        renderedWidth: img.offsetWidth,
        renderedHeight: img.offsetHeight,
        activeHudPersona,
        hudRes,
        hudDisplay
      };
    }, role);

    const switchDuration = (performance.now() - tStart).toFixed(2);

    // Verify natural dimensions are 1024x1024
    if (evalResult.naturalWidth !== 1024 || evalResult.naturalHeight !== 1024) {
      throw new Error(`Persona ${role} natural resolution is ${evalResult.naturalWidth}x${evalResult.naturalHeight}, expected 1024x1024!`);
    }

    // Verify HUD reflects selected persona
    if (evalResult.activeHudPersona !== role) {
      throw new Error(`HUD persona mismatch: expected ${role}, got ${evalResult.activeHudPersona}`);
    }

    const stat = fs.statSync(path.join(AVATARS_DIR, `${role}.png`));
    metrics.push({
      role,
      fileSizeKb: (stat.size / 1024).toFixed(1),
      naturalDim: `${evalResult.naturalWidth}x${evalResult.naturalHeight}`,
      renderedDim: `${evalResult.renderedWidth}x${evalResult.renderedHeight}`,
      switchLatencyMs: switchDuration,
      status: 'PASS'
    });

    console.log(`[QA Test Controller] Persona ${role.padEnd(8)}: Switch Latency = ${switchDuration}ms, Res = ${evalResult.naturalWidth}x${evalResult.naturalHeight}`);
  }

  // Test Viewport Scaling controls
  const sizesToTest = [512, 128, 48, 32];
  for (const sz of sizesToTest) {
    const sizeBtnSelector = `button.size-btn[data-size="${sz}"]`;
    await page.click(sizeBtnSelector);
    await new Promise((r) => setTimeout(r, 60));

    const renderedSize = await page.$eval('#stage-avatar', (el) => ({
      width: el.offsetWidth,
      height: el.offsetHeight
    }));

    if (Math.abs(renderedSize.width - sz) > 1 || Math.abs(renderedSize.height - sz) > 1) {
      throw new Error(`Viewport scaling failed for ${sz}px: got ${renderedSize.width}x${renderedSize.height}`);
    }
  }

  // Set to 512px and capture evidence
  await page.click('button.size-btn[data-size="512"]');
  await new Promise((r) => setTimeout(r, 100));
  await page.screenshot({ path: path.join(AVATARS_DIR, 'evidence_scaled_512.png') });
  console.log('[QA Test Controller] Captured evidence_scaled_512.png');

  // Reset to 256px showcase
  await page.click('button.size-btn[data-size="256"]');

  // Test Discord Feed Simulation: Dispatch messages for multiple personas
  for (const role of ['atlas', 'alex', 'victor', 'tessa']) {
    await page.click(`#btn-persona-${role}`);
    await page.click('#btn-dispatch-test');
    await new Promise((r) => setTimeout(r, 80));
  }

  const msgCount = await page.$$eval('.discord-msg', (msgs) => msgs.length);
  // 1 initial + 4 dispatched = 5
  if (msgCount !== 5) {
    throw new Error(`Expected 5 messages in Discord feed, found ${msgCount}`);
  }

  await page.screenshot({ path: path.join(AVATARS_DIR, 'evidence_chat_stream.png') });
  console.log('[QA Test Controller] Captured evidence_chat_stream.png');

  // Test feed clear button
  await page.click('#btn-clear-feed');
  const clearedCount = await page.$$eval('.discord-msg', (msgs) => msgs.length);
  if (clearedCount !== 0) {
    throw new Error(`Clear feed failed: ${clearedCount} messages remain`);
  }

  // Restore a fresh message for final snapshot
  await page.click('#btn-persona-tessa');
  await page.click('#btn-dispatch-test');
  await page.screenshot({ path: path.join(AVATARS_DIR, 'evidence_final_verified.png') });

  await browser.close();
  server.close();

  // Print results table
  console.log('\n=== BLACK-BOX TEST SUMMARY ===');
  console.table(metrics);

  if (networkErrors.length > 0) {
    console.error('Network Errors Detected:', networkErrors);
    process.exit(1);
  }

  console.log('All black-box assertions PASSED successfully.');
  return metrics;
}

runBlackBoxValidation().catch((err) => {
  console.error('[QA Test Controller] FATAL ERROR:', err);
  process.exit(1);
});
