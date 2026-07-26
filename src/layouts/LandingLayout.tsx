import React, { useEffect, useState } from 'react';
import { Outlet, Link, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const LandingLayout = () => {
  const { user } = useAuth();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (user) {
    return <Navigate to="/app" replace />;
  }

  return (
    <div className="min-h-screen bg-paper flex flex-col">
      {/* Sticky nav — flat and transparent at the top, gaining a hairline
          border + paper fill on scroll (a clean transition, no blur or heavy
          shadow, per the design system). */}
      <header
        className={`sticky top-0 z-50 transition-[background-color,border-color] duration-300 ${
          scrolled ? 'bg-paper/90 backdrop-blur-sm border-b border-ink/15' : 'bg-transparent border-b border-transparent'
        }`}
      >
        <div className="flex items-center justify-between px-6 md:px-8 py-4 max-w-6xl mx-auto w-full">
          <Link to="/" className="font-serif font-black italic text-2xl tracking-tight text-ink">
            Cirqle
          </Link>
          <nav className="flex items-center gap-2 sm:gap-4 text-sm font-mono">
            <Link
              to="/login"
              className="px-3 py-2 rounded-card font-mono text-xs uppercase tracking-widest text-muted hover:text-ink transition-colors"
            >
              Log in
            </Link>
            <Link
              to="/signup"
              className="rounded-card bg-brand text-brand-on hover:bg-[#8E2A3A] active:bg-[#661D29] active:scale-[0.98] px-4 py-2 font-mono text-xs uppercase tracking-widest font-bold transition-[transform,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 flex flex-col">
        <Outlet />
      </main>
    </div>
  );
};

export default LandingLayout;
