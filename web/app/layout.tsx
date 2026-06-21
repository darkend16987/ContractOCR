import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nabu PDF - Trích xuất hợp đồng tiếng Việt",
  description:
    "Tự động trích xuất thông tin từ hợp đồng tiếng Việt bằng AI (Gemini Vision)",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi">
      <body className="min-h-screen">
        {children}
      </body>
    </html>
  );
}
