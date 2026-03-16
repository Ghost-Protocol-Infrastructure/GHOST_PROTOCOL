import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import "@rainbow-me/rainbowkit/styles.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "GHOST_PROTOCOL",
  description: "Infrastructure for the Agentic Economy",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <meta name="base:app_id" content="69b6261768ed07045acf8f00" />
      </head>
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
