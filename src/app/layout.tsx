import type { Metadata } from 'next'
import '@xyflow/react/dist/style.css'
import './globals.css'

export const metadata: Metadata = {
  title: 'AI Short Drama Studio',
  description: 'Asset library and image generation workspace for AI short drama teams',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
