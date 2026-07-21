const { mkdir, readFile, stat } = require('node:fs/promises')
const { resolve } = require('node:path')
const { chromium } = require('playwright')

const baseUrl = 'http://localhost:14000'
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

async function run() {
  const browser = await chromium.launch({ executablePath: edgePath, headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`)
    })
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`${response.status()}: ${response.url()}`)
    })

    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    if (page.url().includes('/login')) {
      await page.locator('input[type="email"]').fill('admin@example.com')
      await page.locator('input[type="password"]').fill('changeme123')
      await page.getByRole('button', { name: '登录' }).click()
      await page.waitForURL(`${baseUrl}/`, { timeout: 20_000 })
    }
    console.log('download-check: logged in')

    const editTab = page.locator('.mainTabs button').filter({ hasText: '成片剪辑' })
    console.log(`download-check: edit tab count ${await editTab.count()}`)
    await editTab.click()
    await page.waitForTimeout(1_000)
    if (!(await editTab.evaluate((button) => button.classList.contains('active')))) {
      await editTab.evaluate((button) => button.click())
      await page.waitForTimeout(1_000)
    }
    console.log(`download-check: active tab ${await page.locator('.mainTabs button.active').textContent()}`)
    console.log(`download-check: page errors ${JSON.stringify(errors)}`)
    await page.locator('.editWorkspace').waitFor({ timeout: 10_000 })
    const preview = page.locator('.finalStage video')
    await preview.waitFor()
    await page.waitForTimeout(2_000)
    const previewDuration = await preview.evaluate((video) => Number.isFinite(video.duration) ? video.duration : 0)
    console.log(`download-check: preview duration ${previewDuration}`)

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await page.getByRole('link', { name: '下载当前 MP4' }).click()
    const download = await downloadPromise
    const suggestedFilename = download.suggestedFilename()
    const outputDirectory = resolve('artifacts', 'download-test')
    await mkdir(outputDirectory, { recursive: true })
    const outputPath = resolve(outputDirectory, suggestedFilename)
    await download.saveAs(outputPath)
    const failure = await download.failure()
    const fileStat = await stat(outputPath)
    const header = await readFile(outputPath).then((buffer) => buffer.subarray(0, 16).toString('hex'))

    console.log(JSON.stringify({
      previewDuration,
      suggestedFilename,
      outputPath,
      sizeBytes: fileStat.size,
      mp4HeaderContainsFtyp: header.includes('66747970'),
      failure,
      errors,
    }, null, 2))
  } finally {
    await browser.close()
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
