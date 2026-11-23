import type { Metadata } from 'next';
import { JetBrains_Mono, Reddit_Sans } from 'next/font/google';
import './globals.css';

// Self-hosted at build time by next/font: no request to Google at runtime (local-first).
const reddit = Reddit_Sans({ subsets: ['latin'], variable: '--font-reddit', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-jetbrains', display: 'swap' });

export const metadata: Metadata = {
  title: 'AI Creator Studio',
  description: 'Local-first Creative-DNA- und Content-Studio',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" className={`${reddit.variable} ${mono.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
