import { LoginForm } from '@/components/admin/LoginForm';
import { ThemeToggle } from '@/components/ThemeToggle';

export const metadata = { title: 'Sign in — ServerlessMailer' };

export default function LoginPage() {
  return (
    <main className="sm-login">
      <div className="sm-login-card">
        <h1>
          <span className="sm-brand-dot" aria-hidden />
          ServerlessMailer
        </h1>
        <p className="muted">Sign in to manage lists, campaigns, and sending.</p>
        <LoginForm />
      </div>
      <div className="sm-login-theme">
        <ThemeToggle />
      </div>
    </main>
  );
}
