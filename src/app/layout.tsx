import type { Metadata } from 'next'
import Link from 'next/link'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'DigitalTwin2026',
  description: 'Personal digital twin system',
}

const nav = [
  { href: '/', label: 'Dashboard' },
  { href: '/records', label: 'Records' },
  { href: '/tags', label: 'Tags' },
  { href: '/settings', label: 'Settings' },
]

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <header className="border-b border-border bg-nav">
          <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center gap-4">
            <Link href="/" className="font-semibold tracking-tight text-foreground">
              DigitalTwin2026
            </Link>
            <nav className="flex flex-wrap gap-3 text-sm">
              {nav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  )
}
