import React from 'react';
import { Outlet, Link, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const LandingLayout = () => {
  const { user } = useAuth();
  if (user) {
    return <Navigate to="/app" replace />;
  }

  return (
    <div className="min-h-screen bg-paper flex flex-col">
      <header className="flex items-center justify-between p-6 max-w-7xl mx-auto w-full border-b border-ink/10">
        <div className="flex items-center gap-2">
          <Link to="/" className="font-serif font-bold text-2xl tracking-tighter text-ink">Cirqle</Link>
        </div>
        <nav className="flex items-center gap-6 text-sm font-mono">
          <Link to="/login" className="hover:underline">Log in</Link>
          <Link to="/signup" className="border border-ink bg-transparent hover:bg-ink hover:text-paper px-4 py-2 transition-colors">
            Get Started Free
          </Link>
        </nav>
      </header>
      
      <main className="flex-1 flex flex-col">
        <Outlet />
      </main>
    </div>
  );
};

export default LandingLayout;
