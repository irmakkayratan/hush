import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HUSH",
  description: "Turn team notes into updates for existing Notion tasks.",
  icons: { apple: [{ url: "/hush-icons/apple-touch-icon.png", sizes: "180x180" }] },
  appleWebApp: { capable: true, title: "HUSH" },
};

export const viewport: Viewport = { themeColor: "#ffffff" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
