import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '标题雷达｜抖音与哔哩哔哩标题分析',
  description: '基于视频转写与本地画面抽帧，分析内容结构并生成透明可解释的双平台标题建议。',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="dark">
      <body>{children}</body>
    </html>
  );
}
