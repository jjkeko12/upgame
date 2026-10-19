import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Game Asset Extractor & Player",
  description: "Upload game files, extract assets, and play games in the browser",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-900 text-slate-100 antialiased">{children}</body>
    </html>
  );
}
