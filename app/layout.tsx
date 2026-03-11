import type { Metadata } from "next";
import { Header } from "@/components/header";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rebid Reasons",
  description: "AEMO NEM Rebid Reason Generator",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased font-sans">
        <Header />
        <div className="min-h-screen bg-background">
          <main className="p-2 md:p-3">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
