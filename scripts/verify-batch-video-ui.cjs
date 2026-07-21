const { chromium } = require('playwright')
const path = require('node:path')

const baseUrl = 'http://localhost:14000'
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const output = (name) => path.resolve('artifacts', name)

async function login(page) {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
  await page.waitForFunction(() => {
    const button = document.querySelector('.loginForm button')
    return button && Object.keys(button).some((key) => key.startsWith('__reactProps'))
  }, { timeout: 20_000 })
  if (page.url().endsWith('/login')) {
    await page.getByLabel('邮箱').fill('admin@example.com')
    await page.getByLabel('密码').fill('changeme123')
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => candidate.url().endsWith('/api/auth/login') && candidate.request().method() === 'POST'),
      page.getByRole('button', { name: '登录' }).click(),
    ])
    if (!response.ok()) throw new Error(`Login failed with HTTP ${response.status()}`)
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  }
  await page.locator('.studioShell').waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => {
    const button = document.querySelector('.mainTabs button')
    return button && Object.keys(button).some((key) => key.startsWith('__reactProps'))
  }, { timeout: 20_000 })
}

async function openStoryboardWorkspace(page) {
  await page.getByRole('button', { name: '分镜视频' }).click()
  await page.locator('.storyboardWorkspace').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(900)
}

async function inspect(page, label) {
  const editablePrompt = page.locator('.highlightedTextarea textarea').first()
  const originalPrompt = await editablePrompt.inputValue().catch(() => '')
  let dirtyState = null
  if (originalPrompt) {
    await editablePrompt.fill(`${originalPrompt}\n界面验收临时文本`)
    dirtyState = await page.locator('.promptFieldHeading small').textContent()
    await editablePrompt.fill(originalPrompt)
  }

  const enabledCheckbox = page.locator('.sceneBatchCheck input:not(:disabled)').first()
  const canSelect = await enabledCheckbox.count() > 0
  if (canSelect) await enabledCheckbox.check()

  const metrics = await page.evaluate((name) => {
    const visible = (element) => {
      if (!element) return false
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const overflowing = [...document.querySelectorAll('button, label, strong, small, .sceneMeta')]
      .filter(visible)
      .filter((element) => element.scrollWidth > element.clientWidth + 2)
      .slice(0, 12)
      .map((element) => ({
        className: element.className,
        text: element.textContent?.trim().slice(0, 80),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
    return {
      label: name,
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
      overflowing,
      batchBarVisible: visible(document.querySelector('.batchVideoBar')),
      episodeOptions: document.querySelectorAll('.storyboardEpisodePicker option').length,
      storyboardCheckboxes: document.querySelectorAll('.sceneBatchCheck input').length,
      checkedCount: document.querySelectorAll('.sceneBatchCheck input:checked').length,
      batchButton: document.querySelector('.batchVideoBar .primaryButton')?.textContent?.replace(/\s+/g, ' ').trim(),
      promptLabel: document.querySelector('.promptFieldHeading')?.textContent?.replace(/\s+/g, ' ').trim(),
      timeEstimate: document.querySelector('.modelPriceSummary small')?.textContent?.replace(/\s+/g, ' ').trim(),
    }
  }, label)

  if (canSelect) await enabledCheckbox.uncheck()
  return { ...metrics, promptDirtyState: dirtyState?.trim() || null }
}

async function run() {
  const browser = await chromium.launch({
    executablePath: edgePath,
    headless: true,
    args: ['--disable-gpu', '--disable-background-networking'],
  })
  const errors = []
  const desktop = await browser.newContext({ viewport: { width: 1536, height: 960 } })
  const desktopPage = await desktop.newPage()
  desktopPage.on('pageerror', (error) => errors.push(`desktop: ${error.message}`))
  desktopPage.on('console', (message) => {
    if (message.type() === 'error') errors.push(`desktop console: ${message.text()}`)
  })
  await login(desktopPage)
  await openStoryboardWorkspace(desktopPage)
  const desktopResult = await inspect(desktopPage, 'desktop')
  await desktopPage.screenshot({ path: output('batch-video-desktop.png'), fullPage: true, animations: 'disabled' })
  const storageState = await desktop.storageState()
  await desktop.close()

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState })
  const mobilePage = await mobile.newPage()
  mobilePage.on('pageerror', (error) => errors.push(`mobile: ${error.message}`))
  mobilePage.on('console', (message) => {
    if (message.type() === 'error') errors.push(`mobile console: ${message.text()}`)
  })
  await mobilePage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await mobilePage.locator('.studioShell').waitFor({ timeout: 20_000 })
  await mobilePage.waitForFunction(() => {
    const button = document.querySelector('.mainTabs button')
    return button && Object.keys(button).some((key) => key.startsWith('__reactProps'))
  }, { timeout: 20_000 })
  await openStoryboardWorkspace(mobilePage)
  const mobileResult = await inspect(mobilePage, 'mobile')
  await mobilePage.screenshot({ path: output('batch-video-mobile.png'), fullPage: true, animations: 'disabled' })
  await mobile.close()
  await browser.close()

  const result = { desktop: desktopResult, mobile: mobileResult, errors }
  process.stdout.write(JSON.stringify(result, null, 2))
  if (errors.length > 0 || desktopResult.horizontalOverflow || mobileResult.horizontalOverflow) process.exitCode = 1
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
