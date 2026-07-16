import puppeteer from 'puppeteer-core';

const EXT = '/Users/xiaoanliu/Github/PaperClip/extension';
const browser = await puppeteer.launch({
  executablePath: '/Users/xiaoanliu/.cache/puppeteer/chrome/mac_arm-151.0.7922.34/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  headless: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
  ],
});

let extTarget;
try {
  extTarget = await browser.waitForTarget(t => t.url().startsWith('chrome-extension://'), { timeout: 10000 });
} catch {
  console.log('targets seen:', browser.targets().map(t => `${t.type()}:${t.url()}`).join(' | '));
  process.exit(1);
}
const extId = new URL(extTarget.url()).host;
console.log('ext id:', extId);

const page = await browser.newPage();
page.on('console', m => console.log('[console]', m.type(), m.text().slice(0, 300)));
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 500)));
await page.goto(`chrome-extension://${extId}/index.html`, { waitUntil: 'networkidle2' });

const hasPanel = await page.evaluate(() => typeof window.LectorPanel);
console.log('typeof window.LectorPanel:', hasPanel);

if (hasPanel === 'object') {
  await page.evaluate(() => {
    const body = document.getElementById('pdfPanelBody');
    document.getElementById('pdfPanel').hidden = false;
    document.body.classList.add('pdf-panel-open');
    const holder = document.createElement('div');
    holder.className = 'lector-holder';
    body.appendChild(holder);
    window.LectorPanel.mount(holder, 'https://arxiv.org/pdf/2403.18406', {
      onError: (e) => console.log('LECTOR ONERROR', String(e)),
    });
  });
  await new Promise(r => setTimeout(r, 8000));
  const state = await page.evaluate(() => {
    const b = document.getElementById('pdfPanelBody');
    return {
      canvases: b.querySelectorAll('canvas').length,
      textSpans: b.querySelectorAll('.textLayer span').length,
      toolbar: !!b.querySelector('.lector-toolbar'),
      annotationLinks: b.querySelectorAll('.annotationLayer a').length,
      toolbarButtons: b.querySelectorAll('.lector-btn').length,
    };
  });
  console.log('panel state:', JSON.stringify(state, null, 1).slice(0, 800));
  await page.screenshot({ path: process.env.S + '/lector-test.png' });
}
await browser.close();
