import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sales Claw | 問い合わせフォーム営業をAIで自動化',
  description:
    'Sales ClawはAIとPlaywrightで企業分析、メッセージ生成、問い合わせフォーム入力を自動化する営業支援OSSです。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
