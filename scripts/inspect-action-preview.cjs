const { chromium } = require('playwright')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const videoName = process.argv[2]
if (!videoName) throw new Error('Usage: inspect-action-preview.cjs <video-file-name>')

const artifactsDir = path.resolve('artifacts')
const viewerPath = path.join(artifactsDir, 'inspect-action-preview.html')
const stem = path.basename(videoName, path.extname(videoName))
const times = [1, 5, 10, 14]

async function run() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--disable-gpu', '--allow-file-access-from-files'],
  })
  const page = await browser.newPage({ viewport: { width: 900, height: 540 } })
  const frames = []

  for (const time of times) {
    const url = pathToFileURL(viewerPath)
    url.searchParams.set('src', videoName)
    url.searchParams.set('t', String(time))
    await page.goto(url.href, { waitUntil: 'load' })
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, {
      timeout: 15_000,
    })
    const metadata = await page.locator('#metadata').textContent()
    const screenshot = path.join(artifactsDir, `${stem}-${time}s.png`)
    await page.screenshot({ path: screenshot })
    frames.push({ time, metadata, screenshot })
  }

  await browser.close()
  console.log(JSON.stringify(frames, null, 2))
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
