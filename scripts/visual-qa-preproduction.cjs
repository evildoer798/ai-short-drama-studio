const { chromium } = require('playwright')

const baseUrl = 'http://localhost:14000'
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

async function pageMetrics(page, label) {
  return page.evaluate((name) => {
    const visible = (element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const overflowingText = [...document.querySelectorAll('button, label, strong')]
      .filter(visible)
      .filter((element) => element.scrollWidth > element.clientWidth + 2)
      .slice(0, 12)
      .map((element) => ({ text: element.textContent?.trim().slice(0, 50), className: element.className }))
    return {
      label: name,
      viewport: { width: innerWidth, height: innerHeight },
      body: { clientWidth: document.body.clientWidth, scrollWidth: document.body.scrollWidth },
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      overflowingText,
      activeTab: document.querySelector('.mainTabs button.active')?.textContent?.trim() || '',
    }
  }, label)
}

async function login(page) {
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  if (!page.url().includes('/login')) return
  await page.locator('input[type="email"]').fill('admin@example.com')
  await page.locator('input[type="password"]').fill('changeme123')
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(`${baseUrl}/`, { timeout: 20_000 })
  await page.waitForLoadState('networkidle')
}

async function run() {
  const browser = await chromium.launch({ executablePath: edgePath, headless: true })
  const errors = []
  const results = []
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()} @ ${message.location().url || 'unknown'}`)
  })
  page.on('response', (response) => {
    if (response.status() === 404) errors.push(`404: ${response.url()}`)
  })

  await login(page)
  await page.waitForSelector('.scriptWorkspace')
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'artifacts/preproduction-script-desktop.png', fullPage: false, animations: 'disabled' })
  results.push(await pageMetrics(page, 'script-desktop'))

  const importedText = '这是用于验证 TXT 导入功能的短剧内容。'.repeat(12)
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: '测试短剧.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(importedText, 'utf8'),
  })
  await page.waitForFunction((expected) => {
    const title = document.querySelector('input[placeholder="输入小说名称"]')
    const content = document.querySelector('textarea[placeholder*="小说正文"]')
    return title?.value === '测试短剧' && content?.value === expected
  }, importedText)
  results.push({
    txtImport: 'passed',
    importedTitle: await page.locator('input[placeholder="输入小说名称"]').inputValue(),
    importedCharacters: (await page.locator('textarea[placeholder*="小说正文"]').inputValue()).length,
  })
  await page.screenshot({ path: 'artifacts/preproduction-script-txt-import.png', fullPage: false, animations: 'disabled' })

  await page.getByRole('button', { name: '资产规划' }).click()
  await page.waitForSelector('.assetPlanningWorkspace')
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'artifacts/preproduction-assets-desktop.png', fullPage: false, animations: 'disabled' })
  results.push(await pageMetrics(page, 'asset-plan-desktop'))

  const shotPage = await context.newPage()
  shotPage.on('pageerror', (error) => errors.push(`shot pageerror: ${error.message}`))
  shotPage.on('console', (message) => {
    if (message.type() === 'error') errors.push(`shot console: ${message.text()} @ ${message.location().url || 'unknown'}`)
  })
  await shotPage.goto(baseUrl, { waitUntil: 'networkidle' })
  await shotPage.getByRole('button', { name: '分镜拆解' }).click()
  await shotPage.waitForSelector('.shotPlanningWorkspace')
  await shotPage.waitForTimeout(500)
  await shotPage.screenshot({ path: 'artifacts/preproduction-shots-desktop.png', fullPage: false, animations: 'disabled' })
  results.push(await pageMetrics(shotPage, 'shot-plan-desktop'))

  await context.close()

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })
  const mobilePage = await mobileContext.newPage()
  mobilePage.on('pageerror', (error) => errors.push(`mobile pageerror: ${error.message}`))
  mobilePage.on('response', (response) => {
    if (response.status() === 404) errors.push(`mobile 404: ${response.url()}`)
  })
  await login(mobilePage)
  await mobilePage.waitForSelector('.scriptWorkspace')
  await mobilePage.waitForTimeout(500)
  await mobilePage.screenshot({ path: 'artifacts/preproduction-script-mobile.png', fullPage: true, animations: 'disabled' })
  results.push(await pageMetrics(mobilePage, 'script-mobile'))
  results.push({ mobileAssistant: await mobilePage.locator('.jenniferLauncher').isVisible() ? 'collapsed' : 'open' })

  await browser.close()
  process.stdout.write(JSON.stringify({ results, errors }, null, 2))
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
