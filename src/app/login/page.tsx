import { LoginForm } from '@/components/admin/LoginForm';

export const metadata = { title: 'Sign in — ServerlessMailer' };

export default function LoginPage() {
  return (
    <main style={{ maxWidth: '22rem', margin: '18vh auto', padding: '0 1.25rem' }}>
      <h1 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>ServerlessMailer</h1>
      <LoginForm />
    </main>
  );
}
