const { chromium } = require('playwright')

const baseUrl = 'http://localhost:14000'
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

async function signIn(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  if (!page.url().includes('/login')) return

  const response = await page.context().request.post(`${baseUrl}/api/auth/login`, {
    data: { email: 'admin@example.com', password: 'changeme123' },
  })
  if (!response.ok()) throw new Error(`Login failed with status ${response.status()}`)
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
}

async function clickAndWaitForClass(locator, selector) {
  await locator.click()
  try {
    await locator.page().waitForSelector(selector, { timeout: 2_000 })
  } catch {
    await locator.evaluate((button) => button.click())
    await locator.page().waitForSelector(selector)
  }
  await locator.page().waitForTimeout(240)
}

async function run() {
  const browser = await chromium.launch({ executablePath: edgePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  const errors = []

  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()}: ${response.url()}`)
  })

  console.log('stage: opening app')
  await signIn(page)
  console.log('stage: checking desktop layout')
  await page.waitForSelector('.scriptWorkspace')
  await page.waitForTimeout(500)

  const episodeCount = await page.locator('.episodeList button').count()
  const assistantElements = await page.locator('.jenniferDock, .jenniferLauncher').count()
  const expandedBox = await page.locator('.novelPanel').boundingBox()
  if (!expandedBox) throw new Error('Novel panel is not visible before collapsing')

  await clickAndWaitForClass(
    page.getByRole('button', { name: '收起小说原文' }),
    '.scriptWorkspace.novelCollapsed',
  )

  const collapsedBox = await page.locator('.novelPanel.collapsed').boundingBox()
  const hiddenNovelControls = await page.locator('.novelPanel .novelImportBar').count()
  const editorVisible = await page.locator('.scriptEditorPanel').isVisible()
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
  await page.screenshot({
    path: 'artifacts/script-novel-collapsed-desktop.png',
    fullPage: false,
    animations: 'disabled',
  })

  await clickAndWaitForClass(
    page.getByRole('button', { name: '展开小说原文' }),
    '.scriptWorkspace:not(.novelCollapsed)',
  )
  const restoredBox = await page.locator('.novelPanel').boundingBox()

  console.log('stage: checking mobile layout')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(100)
  await clickAndWaitForClass(
    page.getByRole('button', { name: '收起小说原文' }),
    '.scriptWorkspace.novelCollapsed',
  )
  const mobileBox = await page.locator('.novelPanel.collapsed').boundingBox()
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
  await page.screenshot({
    path: 'artifacts/script-novel-collapsed-mobile.png',
    fullPage: false,
    animations: 'disabled',
  })

  const result = {
    episodeCount,
    assistantElements,
    desktop: {
      expandedWidth: Math.round(expandedBox.width),
      collapsedWidth: collapsedBox ? Math.round(collapsedBox.width) : null,
      restoredWidth: restoredBox ? Math.round(restoredBox.width) : null,
      hiddenNovelControls,
      editorVisible,
      horizontalOverflow: desktopOverflow,
    },
    mobile: {
      collapsedHeight: mobileBox ? Math.round(mobileBox.height) : null,
      horizontalOverflow: mobileOverflow,
    },
    errors,
  }

  console.log(JSON.stringify(result, null, 2))

  if (assistantElements !== 0) throw new Error('Jennifer assistant is still rendered')
  if (!collapsedBox || collapsedBox.width > 72) throw new Error('Desktop novel panel did not collapse')
  if (!restoredBox || restoredBox.width < 250) throw new Error('Novel panel did not expand again')
  if (hiddenNovelControls !== 0 || !editorVisible) throw new Error('Collapsed desktop layout is incomplete')
  if (!mobileBox || mobileBox.height > 70) throw new Error('Mobile novel panel is not compact')
  if (desktopOverflow || mobileOverflow) throw new Error('Page has horizontal overflow')
  if (errors.length > 0) throw new Error(`Browser errors detected: ${errors.join('; ')}`)

  await browser.close()
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
