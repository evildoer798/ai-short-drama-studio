import 'server-only'

import { BillingStatus, BillingTaskType, Prisma } from '@prisma/client'
import { prisma } from './db'

export type BillingFilters = {
  from: Date
  to: Date
  model?: string
  taskType?: BillingTaskType
  userId?: string
}

function decimalString(value: Prisma.Decimal | null | undefined) {
  return value?.toFixed(6) || '0.000000'
}

function startOfCurrentMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

export function parseBillingFilters(
  input: Record<string, string | string[] | undefined>,
  now = new Date(),
): BillingFilters {
  const text = (key: string) => {
    const value = input[key]
    return typeof value === 'string' ? value.trim() : ''
  }
  const parseDay = (value: string, end = false) => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null
    const date = new Date(`${value}T00:00:00+08:00`)
    if (Number.isNaN(date.getTime())) return null
    if (end) date.setUTCDate(date.getUTCDate() + 1)
    return date
  }
  const taskTypeText = text('taskType')
  const taskType = Object.values(BillingTaskType).includes(taskTypeText as BillingTaskType)
    ? taskTypeText as BillingTaskType
    : undefined
  return {
    from: parseDay(text('from')) || startOfCurrentMonth(now),
    to: parseDay(text('to'), true) || now,
    ...(text('model') ? { model: text('model') } : {}),
    ...(taskType ? { taskType } : {}),
    ...(text('userId') ? { userId: text('userId') } : {}),
  }
}

function ledgerWhere(filters: BillingFilters, userId?: string): Prisma.UsageLedgerWhereInput {
  return {
    status: BillingStatus.settled,
    occurredAt: { gte: filters.from, lt: filters.to },
    ...(userId ? { userId } : {}),
    ...(filters.model ? { model: { contains: filters.model, mode: 'insensitive' } } : {}),
    ...(filters.taskType ? { taskType: filters.taskType } : {}),
  }
}

export async function getAccountBillingData(userId: string, filters: BillingFilters) {
  const where = ledgerWhere(filters, userId)
  const [user, aggregate, byType, recent, pending] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true, name: true, role: true },
    }),
    prisma.usageLedger.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }),
    prisma.usageLedger.groupBy({
      by: ['taskType'],
      where,
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.usageLedger.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: 100,
      select: {
        id: true,
        taskType: true,
        sourceType: true,
        sourceTaskId: true,
        model: true,
        quantity: true,
        unit: true,
        unitPrice: true,
        amount: true,
        currency: true,
        pricingVersion: true,
        occurredAt: true,
      },
    }),
    prisma.usageLedger.count({
      where: {
        userId,
        status: BillingStatus.pending,
        occurredAt: { gte: filters.from, lt: filters.to },
      },
    }),
  ])
  return {
    user,
    total: decimalString(aggregate._sum.amount),
    taskCount: aggregate._count._all,
    pendingCount: pending,
    byType: Object.fromEntries(Object.values(BillingTaskType).map((type) => {
      const row = byType.find((candidate) => candidate.taskType === type)
      return [type, { amount: decimalString(row?._sum.amount), count: row?._count._all || 0 }]
    })),
    recent: recent.map((entry) => ({
      ...entry,
      quantity: entry.quantity.toString(),
      unitPrice: entry.unitPrice?.toString() || null,
      amount: entry.amount?.toString() || null,
      occurredAt: entry.occurredAt.toISOString(),
    })),
  }
}

export async function getAdminBillingData(filters: BillingFilters) {
  const where = ledgerWhere(filters, filters.userId)
  const [users, aggregate, grouped, pending, lastUsage] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ createdAt: 'asc' }, { email: 'asc' }],
      select: { id: true, username: true, email: true, name: true, role: true, createdAt: true },
    }),
    prisma.usageLedger.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }),
    prisma.usageLedger.groupBy({
      by: ['userId', 'taskType'],
      where,
      _sum: { amount: true },
      _count: { _all: true },
      _max: { occurredAt: true },
    }),
    prisma.usageLedger.groupBy({
      by: ['userId'],
      where: {
        status: BillingStatus.pending,
        occurredAt: { gte: filters.from, lt: filters.to },
        ...(filters.userId ? { userId: filters.userId } : {}),
        ...(filters.model ? { model: { contains: filters.model, mode: 'insensitive' } } : {}),
        ...(filters.taskType ? { taskType: filters.taskType } : {}),
      },
      _count: { _all: true },
    }),
    prisma.usageLedger.groupBy({
      by: ['userId'],
      where,
      _max: { occurredAt: true },
    }),
  ])

  const accounts = users.map((user) => {
    const rows = grouped.filter((row) => row.userId === user.id)
    const amount = rows.reduce((sum, row) => sum.plus(row._sum.amount || 0), new Prisma.Decimal(0))
    const byType = Object.fromEntries(Object.values(BillingTaskType).map((type) => {
      const row = rows.find((candidate) => candidate.taskType === type)
      return [type, decimalString(row?._sum.amount)]
    }))
    return {
      ...user,
      createdAt: user.createdAt.toISOString(),
      amount: amount.toFixed(6),
      taskCount: rows.reduce((sum, row) => sum + row._count._all, 0),
      pendingCount: pending.find((row) => row.userId === user.id)?._count._all || 0,
      lastUsageAt: lastUsage.find((row) => row.userId === user.id)?._max.occurredAt?.toISOString() || null,
      byType,
    }
  }).sort((left, right) => Number(right.amount) - Number(left.amount))

  return {
    total: decimalString(aggregate._sum.amount),
    taskCount: aggregate._count._all,
    activeAccounts: accounts.filter((account) => account.taskCount > 0).length,
    pendingCount: accounts.reduce((sum, account) => sum + account.pendingCount, 0),
    accounts,
  }
}
