import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Parakh Eval Lab',
  description: 'Measured quality, cost, and retrieval performance for Parakh code review.',
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
