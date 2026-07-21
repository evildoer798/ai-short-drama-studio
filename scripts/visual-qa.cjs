const { chromium } = require('playwright')
const path = require('node:path')

const baseUrl = 'http://localhost:14000'
const output = (name) => path.resolve('artifacts', name)
let activeBrowser = null

async function login(page) {
  console.log('qa: opening login')
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
  await page.waitForTimeout(700)
  if (page.url().endsWith('/login')) {
    await page.getByLabel('邮箱').fill('admin@example.com')
    await page.getByLabel('密码').fill('changeme123')
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL('**/', { timeout: 15_000 })
  }
  await page.locator('.studioShell').waitFor({ timeout: 15_000 })
  await page.waitForFunction(() => {
    const button = document.querySelector('.mainTabs button')
    return button && Object.keys(button).some((key) => key.startsWith('__reactProps'))
  }, { timeout: 15_000 })
  console.log('qa: logged in')
}

async function inspect(page) {
  return page.evaluate(() => {
    const overflowing = [...document.querySelectorAll('button, label, summary, .assetTileBody, .sceneMeta')]
      .filter((element) => element.scrollWidth > element.clientWidth + 2)
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName,
        className: element.className,
        text: element.textContent?.trim().slice(0, 80),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
    const brokenImages = [...document.images]
      .filter((image) => image.complete && image.naturalWidth === 0)
      .map((image) => image.alt)
    const videos = [...document.querySelectorAll('video')].map((video) => ({
      currentSrc: video.currentSrc,
      readyState: video.readyState,
      duration: Number.isFinite(video.duration) ? video.duration : null,
    }))
    const assetHighlights = [...document.querySelectorAll('.highlightedTextareaMirror mark')].map((mark) => ({
      text: mark.textContent,
      type: mark.getAttribute('data-asset-type'),
    }))
    const assistantPanel = document.querySelector('.jenniferPanel')
    const assistantSprite = document.querySelector('.jenniferSprite')
    const selectedVideoModel = document.querySelector('.videoModelControl select')
    const selectedVideoModelOption = selectedVideoModel?.querySelector('option:checked')
    return {
      viewport: { width: innerWidth, height: innerHeight },
      bodyWidth: document.body.scrollWidth,
      horizontalOverflow: document.body.scrollWidth > innerWidth + 2,
      overflowing,
      brokenImages,
      videos,
      assetHighlights,
      videoSettings: {
        model: selectedVideoModelOption?.textContent?.trim() || null,
        price: document.querySelector('.modelPriceSummary')?.textContent?.replace(/\s+/g, ' ').trim() || null,
        resolutions: [...document.querySelectorAll('.settingControl .ratioControl button')]
          .map((button) => button.textContent?.trim()),
        aspectRatios: [...document.querySelectorAll('.aspectRatioControl option')]
          .map((option) => option.textContent?.trim()),
      },
      assistant: {
        panelVisible: Boolean(assistantPanel),
        title: assistantPanel?.querySelector('h2')?.textContent || null,
        spriteBackground: assistantSprite ? getComputedStyle(assistantSprite).backgroundImage : null,
      },
    }
  })
}

async function run() {
  console.log('qa: starting browser')
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    timeout: 15_000,
    args: ['--disable-gpu', '--disable-background-networking'],
  })
  activeBrowser = browser
  console.log('qa: browser started')
  const consoleErrors = []
  const failedResponses = []

  const desktop = await browser.newContext({ viewport: { width: 1536, height: 960 } })
  const page = await desktop.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() })
  })
  await login(page)
  await page.locator('.mainTabs button').filter({ hasText: '资产生图' }).click()
  await page.waitForTimeout(500)
  console.log('qa: asset navigation', await page.evaluate(() => ({
    active: document.querySelector('.mainTabs button.active')?.textContent?.trim(),
    body: document.body.innerText.slice(0, 500),
  })))
  console.log('qa: browser diagnostics', { consoleErrors, failedResponses })
  await page.locator('.assetWorkspace').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: output('studio-assets-desktop.png'), fullPage: true })
  console.log('qa: desktop assets captured')
  const desktopAssets = await inspect(page)
  const assistantActionLabel = await page.locator('.assistantAction').textContent()
  await page.locator('.assistantAction').click()
  await page.waitForTimeout(250)
  const assistantActionResult = await page.evaluate(() => ({
    focusedTarget: document.activeElement?.getAttribute('data-assistant-target'),
    activeAssetType: document.querySelector('[data-asset-type].active')?.getAttribute('data-asset-type'),
  }))
  await page.locator('.assistantClose').click()
  await page.locator('.jenniferLauncher').waitFor()
  await page.locator('.jenniferLauncher').click()
  await page.locator('.jenniferPanel').waitFor()

  await page.getByRole('button', { name: '分镜视频' }).click()
  await page.locator('.storyboardWorkspace').waitFor()
  await page.waitForTimeout(1800)
  await page.screenshot({ path: output('studio-storyboards-desktop.png'), fullPage: true })
  console.log('qa: desktop storyboards captured')
  const desktopStoryboards = await inspect(page)
  const storageState = await desktop.storageState()
  await desktop.close()

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState,
  })
  const mobilePage = await mobile.newPage()
  mobilePage.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  mobilePage.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() })
  })
  await mobilePage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await mobilePage.waitForFunction(() => {
    const button = document.querySelector('.mainTabs button')
    return button && Object.keys(button).some((key) => key.startsWith('__reactProps'))
  }, { timeout: 15_000 })
  await mobilePage.locator('.mainTabs button').filter({ hasText: '资产生图' }).click()
  await mobilePage.locator('.assetWorkspace').waitFor({ timeout: 10_000 })
  await mobilePage.waitForTimeout(800)
  await mobilePage.screenshot({ path: output('studio-assets-mobile.png'), fullPage: true })
  console.log('qa: mobile assets captured')
  const mobileAssets = await inspect(mobilePage)

  await mobilePage.getByRole('button', { name: '分镜视频' }).click()
  await mobilePage.locator('.storyboardWorkspace').waitFor()
  await mobilePage.waitForTimeout(1200)
  await mobilePage.screenshot({ path: output('studio-storyboards-mobile.png'), fullPage: true })
  console.log('qa: mobile storyboards captured')
  const mobileStoryboards = await inspect(mobilePage)

  await mobile.close()
  await browser.close()
  activeBrowser = null
  console.log(JSON.stringify({
    desktopAssets,
    desktopStoryboards,
    mobileAssets,
    mobileStoryboards,
    assistantAction: { label: assistantActionLabel?.trim(), ...assistantActionResult },
    consoleErrors,
    failedResponses,
  }, null, 2))
}

run().catch(async (error) => {
  await activeBrowser?.close().catch(() => {})
  console.error(error)
  process.exitCode = 1
})
