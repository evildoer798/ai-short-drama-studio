const { chromium } = require('playwright')

const baseUrl = 'http://localhost:14000'
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

async function run() {
  const browser = await chromium.launch({ executablePath: edgePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
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
  await page.waitForSelector('.scriptWorkspace')
  await page.waitForFunction(() => document.querySelectorAll('.episodeList button').length === 15)

  const episodeButtons = page.locator('.episodeList button')
  const titles = await episodeButtons.locator('strong').allTextContents()
  await episodeButtons.nth(14).click()
  await page.getByText('第 15 集', { exact: true }).waitFor()
  const contentLength = (await page.locator('.scriptContentField textarea').inputValue()).length
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
  await page.screenshot({ path: 'artifacts/script-15-episodes.png', fullPage: false, animations: 'disabled' })

  console.log(JSON.stringify({
    episodeCount: await episodeButtons.count(),
    titles,
    selectedEpisode: 15,
    selectedContentLength: contentLength,
    horizontalOverflow,
    errors,
  }, null, 2))
  await browser.close()
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
