import Link from 'next/link'
import {
  ArrowLeft,
  CircleDollarSign,
  CheckCircle2,
  Clock3,
  ImageIcon,
  Music2,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Video,
} from 'lucide-react'
import type { BillingFilters, getAccountBillingData, getAdminBillingData } from '@/lib/billing-data'

type AccountData = Awaited<ReturnType<typeof getAccountBillingData>>
type AdminData = Awaited<ReturnType<typeof getAdminBillingData>>

type PricingState = {
  version: string
  fetchedAt: Date
  stale: boolean
} | null

const taskLabels = {
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
} as const

function money(value: string | null | undefined) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(Number(value || 0))
}

function dateTime(value: string | Date | null | undefined) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function quantityLabel(quantity: string, unit: string) {
  if (unit === 'image') return `${quantity} 张`
  if (unit === 'second') return `${quantity} 秒`
  if (unit === 'token') return `${new Intl.NumberFormat('zh-CN').format(Number(quantity))} tokens`
  return `${quantity} 条`
}

function dateInput(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value)
  const get = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function typeIcon(type: keyof typeof taskLabels) {
  if (type === 'image') return <ImageIcon size={15} />
  if (type === 'video') return <Video size={15} />
  if (type === 'audio') return <Music2 size={15} />
  return <CircleDollarSign size={15} />
}

function BillingFiltersForm({ filters, admin }: { filters: BillingFilters, admin: boolean }) {
  return (
    <form className="billingFilters" method="get">
      <label>开始日期<input type="date" name="from" defaultValue={dateInput(filters.from)} /></label>
      <label>结束日期<input type="date" name="to" defaultValue={dateInput(new Date(filters.to.getTime() - 1))} /></label>
      <label>模型<input name="model" defaultValue={filters.model || ''} placeholder="例如 seedance" /></label>
      <label>类型<select name="taskType" defaultValue={filters.taskType || ''}>
        <option value="">全部类型</option>
        {Object.entries(taskLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
      {admin && filters.userId ? <input type="hidden" name="userId" value={filters.userId} /> : null}
      <button className="billingFilterSubmit" type="submit">应用筛选</button>
      <Link className="billingFilterReset" href={admin ? '/admin/billing' : '/billing'}>重置</Link>
    </form>
  )
}

function PricingStatus({ pricing }: { pricing: PricingState }) {
  return (
    <div className={`billingPricingStatus ${!pricing || pricing.stale ? 'warning' : ''}`}>
      {!pricing || pricing.stale ? <TriangleAlert size={17} /> : <CheckCircle2 size={17} />}
      <div>
        <strong>{!pricing ? '官方价格暂时不可用' : pricing.stale ? '正在使用最近一次官方价格快照' : '已同步苍源官方价格'}</strong>
        <span>{pricing ? `版本 ${pricing.version.slice(0, 12)} · ${dateTime(pricing.fetchedAt)}` : '成功生成不会被阻断，费用将进入待核对队列。'}</span>
      </div>
      <a href="https://ai.cangyuansuanli.cn/pricing" target="_blank" rel="noreferrer">查看官方价格</a>
    </div>
  )
}

function AccountSummary({ data }: { data: AccountData }) {
  return (
    <section className="billingSummary" aria-label="费用摘要">
      <div className="billingPrimaryMetric"><span>所选周期总费用</span><strong>{money(data.total)}</strong><small>{data.taskCount} 次成功生成</small></div>
      {(['image', 'video', 'audio', 'text'] as const).map((type) => (
        <div key={type}><span>{typeIcon(type)}{taskLabels[type]}</span><strong>{money(data.byType[type].amount)}</strong><small>{data.byType[type].count} 次</small></div>
      ))}
      <div><span><Clock3 size={15} />待核对</span><strong>{data.pendingCount}</strong><small>价格恢复后自动补账</small></div>
    </section>
  )
}

function UsageTable({ data }: { data: AccountData }) {
  return (
    <section className="billingSection">
      <div className="billingSectionHeading"><div><h2>消费明细</h2><p>每一行都保存生成时的官方单价与价格版本。</p></div><span>{data.recent.length} 条</span></div>
      <div className="billingTableScroll">
        <table className="billingTable">
          <thead><tr><th>时间</th><th>类型</th><th>模型</th><th>数量</th><th>结算单价</th><th>金额</th><th>价格版本</th></tr></thead>
          <tbody>
            {data.recent.map((entry) => (
              <tr key={entry.id}>
                <td>{dateTime(entry.occurredAt)}</td>
                <td><span className="billingTypeCell">{typeIcon(entry.taskType)}{taskLabels[entry.taskType]}</span></td>
                <td><strong>{entry.model}</strong><small>{entry.sourceType}</small></td>
                <td>{quantityLabel(entry.quantity, entry.unit)}</td>
                <td>{entry.taskType === 'text' ? '按输入 / 输出 token' : money(entry.unitPrice)}</td>
                <td className="billingAmount">{money(entry.amount)}</td>
                <td><code>{entry.pricingVersion?.slice(0, 12) || '待核对'}</code></td>
              </tr>
            ))}
            {data.recent.length === 0 ? <tr><td className="billingEmpty" colSpan={7}>这个周期内还没有成功生成记录。完成一次图片或视频生成后，费用会自动出现在这里。</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function AdminAccountTable({ data, filters }: { data: AdminData, filters: BillingFilters }) {
  const params = new URLSearchParams()
  params.set('from', dateInput(filters.from))
  params.set('to', dateInput(new Date(filters.to.getTime() - 1)))
  if (filters.model) params.set('model', filters.model)
  if (filters.taskType) params.set('taskType', filters.taskType)
  return (
    <section className="billingSection">
      <div className="billingSectionHeading"><div><h2>账号费用</h2><p>包含零消费账号；点击账号可查看逐笔费用。</p></div><span>{data.accounts.length} 个账号</span></div>
      <div className="billingTableScroll">
        <table className="billingTable billingAccountTable">
          <thead><tr><th>账号</th><th>图片</th><th>视频</th><th>音频</th><th>文本</th><th>总费用</th><th>任务</th><th>最近消费</th><th /></tr></thead>
          <tbody>{data.accounts.map((account) => {
            const accountParams = new URLSearchParams(params)
            accountParams.set('userId', account.id)
            return <tr key={account.id}>
              <td><strong>{account.username || account.name}</strong><small>{account.email}{account.role === 'admin' ? ' · 管理员' : ''}</small></td>
              <td>{money(account.byType.image)}</td><td>{money(account.byType.video)}</td><td>{money(account.byType.audio)}</td><td>{money(account.byType.text)}</td>
              <td className="billingAmount">{money(account.amount)}</td>
              <td>{account.taskCount}{account.pendingCount ? <small>{account.pendingCount} 笔待核对</small> : null}</td>
              <td>{dateTime(account.lastUsageAt)}</td>
              <td><Link className="billingDetailLink" href={`/admin/billing?${accountParams.toString()}`}>查看明细</Link></td>
            </tr>
          })}</tbody>
        </table>
      </div>
    </section>
  )
}

export function BillingWorkspace(props: {
  admin: boolean
  canAdmin?: boolean
  filters: BillingFilters
  accountData: AccountData | null
  adminData?: AdminData
  pricing: PricingState
  syncAction?: () => Promise<void>
}) {
  const selectedAccount = props.accountData?.user
  return (
    <main className="billingShell">
      <header className="billingHeader">
        <Link className="billingBack" href="/"><ArrowLeft size={17} /><span>返回项目</span></Link>
        <div className="billingIdentity"><span><CircleDollarSign size={19} /></span><strong>费用中心</strong></div>
        <nav>
          <Link className={!props.admin ? 'active' : ''} href="/billing">我的费用</Link>
          {props.admin || props.canAdmin ? <Link className={props.admin ? 'active' : ''} href="/admin/billing"><ShieldCheck size={15} />管理员后台</Link> : null}
        </nav>
      </header>
      <div className="billingMain">
        <section className="billingTitlebar">
          <div><h1>{props.admin ? '账号费用管理' : '我的费用'}</h1><p>{props.admin ? '查看每个账号在图片、视频和音频生成中的实际花费。' : '只显示当前账号产生的费用，其他账号无法查看。'}</p></div>
          {props.admin && props.syncAction ? <form action={props.syncAction}><button className="billingSyncButton" type="submit"><RefreshCw size={16} />同步价格并补齐历史消费</button></form> : null}
        </section>
        <PricingStatus pricing={props.pricing} />
        <BillingFiltersForm filters={props.filters} admin={props.admin} />

        {props.admin && props.adminData ? (
          <section className="billingSummary admin" aria-label="全站费用摘要">
            <div className="billingPrimaryMetric"><span>所选周期总支出</span><strong>{money(props.adminData.total)}</strong><small>{props.adminData.taskCount} 次成功生成</small></div>
            <div><span>活跃计费账号</span><strong>{props.adminData.activeAccounts}</strong><small>共 {props.adminData.accounts.length} 个账号</small></div>
            <div><span>待核对账目</span><strong>{props.adminData.pendingCount}</strong><small>价格同步后自动处理</small></div>
          </section>
        ) : null}

        {props.admin && props.adminData ? <AdminAccountTable data={props.adminData} filters={props.filters} /> : null}

        {props.accountData ? (
          <>
            {props.admin ? <div className="billingSelectedAccount"><div><span>账号明细</span><strong>{selectedAccount?.username || selectedAccount?.name}</strong><small>{selectedAccount?.email}</small></div><Link href="/admin/billing">关闭明细</Link></div> : null}
            <AccountSummary data={props.accountData} />
            <UsageTable data={props.accountData} />
          </>
        ) : null}
      </div>
    </main>
  )
}
