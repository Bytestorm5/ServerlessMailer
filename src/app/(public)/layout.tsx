/** Shell for the pages a subscriber sees. Deliberately plain and fast. */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 p-6">
      <div className="w-full max-w-lg rounded-lg border border-ink-200 bg-white p-8 shadow-sm">{children}</div>
    </div>
  );
}
