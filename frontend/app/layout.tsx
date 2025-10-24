import type { Metadata } from "next";
import "./globals.css";
import { WalletProvider } from "@/components/WalletProvider";

export const metadata: Metadata = {
  title: "BTC Prediction Market | Terminal",
  description: "Solana-based prediction market for Bitcoin price movements",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="terminal-screen scanlines">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
