import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("http://127.0.0.1:3000"),
  title: {
    default: "马帮刊登工作台",
    template: "%s | 马帮刊登工作台",
  },
  description: "连接马帮刊登接口，动态查询多店铺商品并安全执行批量变更",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: "/",
    siteName: "马帮刊登工作台",
    title: "马帮刊登工作台",
    description: "动态查询多店铺商品，预览并同步批量价格、库存和包裹字段变更",
    images: [
      {
        url: "/og.png",
        width: 1680,
        height: 900,
        alt: "多店铺电商刊登工作台抽象界面",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "马帮刊登工作台",
    description: "动态查询多店铺商品并安全同步批量变更",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
