import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NEM Dashboard",
  description: "AEMO NEM Dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased font-sans">
        <div className="min-h-screen bg-background">
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
