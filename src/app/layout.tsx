import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Fraunces } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-jakarta", display: "swap" });
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap" });

export const metadata: Metadata = {
  title: "LOCUS Finance",
  description: "LOCUS Finance Intelligence Platform",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${fraunces.variable}`}>
      <body>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <script dangerouslySetInnerHTML={{ __html: `(function(){try{var t=localStorage.getItem('locus-theme');document.documentElement.setAttribute('data-theme', t==='dark' ? 'dark' : 'light');}catch(e){document.documentElement.setAttribute('data-theme','light');}})();` }} />
      <main id="main-content" role="main">{children}</main>
    </body>
    </html>
  );
}
