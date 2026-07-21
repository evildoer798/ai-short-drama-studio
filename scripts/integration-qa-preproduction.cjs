const { PrismaClient } = require('@prisma/client')
const { chromium } = require('playwright')

const prisma = new PrismaClient()
const baseUrl = 'http://localhost:14000'
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

async function run() {
  const suffix = Date.now().toString(36)
  const projectName = `流程验收-${suffix}`
  let workspaceId = ''
  let browser

  try {
    const user = await prisma.user.findUnique({ where: { email: 'admin@example.com' } })
    if (!user) throw new Error('seed admin user is missing')
    const workspace = await prisma.workspace.create({
      data: {
        name: projectName,
        projects: {
          create: {
            name: projectName,
            members: { create: { userId: user.id, role: 'owner' } },
            novelSource: {
              create: {
                title: 'QA 小说',
                content: '这是一段用于流程验收的小说正文。'.repeat(12),
              },
            },
            scriptEpisodes: {
              create: {
                episodeNumber: 1,
                title: '测试分集',
                logline: '验证评论和锁定状态',
                content: '场次一｜夜晚｜室内｜客厅\n苏文菁坐在沙发上看向平板。\n苏文菁：下周我过来带你们见面吃饭。\n陈蕊：哦。',
              },
            },
          },
        },
      },
    })
    workspaceId = workspace.id

    browser = await chromium.launch({ executablePath: edgePath, headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    if (page.url().includes('/login')) {
      await page.locator('input[type="email"]').fill('admin@example.com')
      await page.locator('input[type="password"]').fill('changeme123')
      await page.getByRole('button', { name: '登录' }).click()
      await page.waitForURL(`${baseUrl}/`)
    }

    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(250)

    await page.locator('.headerActions select').selectOption({ label: projectName })
    await page.waitForFunction(() => document.querySelector('.novelPanel input')?.value === 'QA 小说')
    const script = page.locator('.scriptContentField textarea')
    await script.click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.down('Shift')
    for (let index = 0; index < 8; index++) await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Shift')
    await page.locator('[data-assistant-target="script-comment"]').fill('保留动作，补充克制而冷淡的眼神。')
    await page.getByRole('button', { name: '添加评论' }).click()
    await page.waitForFunction(() => document.querySelectorAll('.commentList article').length === 1)

    await page.getByRole('button', { name: '锁定本集' }).click()
    await page.waitForTimeout(350)
    const lockStillBlocked = await page.getByRole('button', { name: '锁定本集' }).isVisible()
    if (!lockStillBlocked) throw new Error('episode locked despite unresolved comment')

    await page.locator('.commentList article button[title="删除评论"]').click()
    await page.waitForFunction(() => document.querySelectorAll('.commentList article').length === 0)
    await page.getByRole('button', { name: '锁定本集' }).click()
    await page.getByRole('button', { name: '解锁' }).waitFor()

    await page.getByRole('button', { name: '资产规划', exact: true }).click()
    await page.waitForSelector('.assetPlanningWorkspace')
    const extractionEnabled = await page.locator('[data-assistant-target="extract-assets"]').isEnabled()
    if (!extractionEnabled) throw new Error('asset extraction did not unlock after script approval')

    process.stdout.write(JSON.stringify({
      commentCreated: true,
      unresolvedCommentBlockedLock: true,
      lockAfterCommentRemoval: true,
      assetExtractionEnabled: true,
    }, null, 2))
  } finally {
    if (browser) await browser.close()
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined)
    await prisma.$disconnect()
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
