import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router';
import { MotionConfig } from 'motion/react';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { ConfirmProvider } from './contexts/ConfirmContext';

// The landing surface stays eager because it is the first paint. The
// authenticated shell (tour, command palette, voice jobs, session controls)
// is loaded only after a visitor enters /app.
import LandingLayout from './layouts/LandingLayout';
import LandingPage from './pages/LandingPage';

const AppRoute = lazy(() => import('./layouts/AppRoute'));
const AuthPage = lazy(() => import('./pages/AuthPage'));
const AuthActionPage = lazy(() => import('./pages/AuthActionPage'));
const PublicCard = lazy(() => import('./pages/PublicCard'));

// In-app pages are route-split so a logged-out visitor (the landing page —
// the highest-leverage surface) never downloads the heavy in-app code:
// react-force-graph-2d (NetworkGraph), pdfjs (Settings), the Tracker, etc.
// Each becomes its own chunk, fetched on navigation. The Suspense boundary
// for these lives in AppLayout, around the Outlet.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Directory = lazy(() => import('./pages/Directory'));
const NetworkGraph = lazy(() => import('./pages/NetworkGraph'));
const ContactDetail = lazy(() => import('./pages/ContactDetail'));
const Tracker = lazy(() => import('./pages/Tracker'));
const OutreachCalendar = lazy(() => import('./pages/OutreachCalendar'));
const Templates = lazy(() => import('./pages/Templates'));
const Settings = lazy(() => import('./pages/Settings'));

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <BrowserRouter>
              <Suspense
                fallback={
                  <main
                    className="grid min-h-screen place-items-center bg-paper font-mono text-sm text-subtle"
                    role="status"
                    aria-live="polite"
                  >
                    Opening Cirqle…
                  </main>
                }
              >
                <Routes>
                  {/* Public NFC card page. Deliberately outside both layouts:
                      someone who tapped a chip should land on a card, not on
                      a product's chrome. No auth gate of any kind. */}
                  <Route path="/c/:cardId" element={<PublicCard />} />
                  <Route path="/auth/action" element={<AuthActionPage />} />

                  <Route path="/" element={<LandingLayout />}>
                    <Route index element={<LandingPage />} />
                    <Route path="login" element={<AuthPage />} />
                    <Route path="signup" element={<AuthPage />} />
                  </Route>

                  <Route path="/app" element={<AppRoute />}>
                    <Route index element={<Dashboard />} />
                    <Route path="directory" element={<Directory />} />
                    <Route path="directory/:id" element={<ContactDetail />} />
                    <Route path="graph" element={<NetworkGraph />} />
                    <Route path="tracker" element={<Tracker />} />
                    <Route path="calendar" element={<OutreachCalendar />} />
                    <Route path="templates" element={<Templates />} />
                    <Route path="settings" element={<Settings />} />
                  </Route>
                </Routes>
              </Suspense>
            </BrowserRouter>
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    </MotionConfig>
  );
}
