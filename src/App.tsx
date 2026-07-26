import React, { lazy } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { MotionConfig } from 'motion/react';
import { AuthProvider } from './contexts/AuthContext';
import { TourProvider } from './contexts/TourContext';
import { ToastProvider } from './contexts/ToastContext';
import { ConfirmProvider } from './contexts/ConfirmContext';

// Layouts + the pre-signup surfaces stay eager — they're the first paint.
import LandingLayout from './layouts/LandingLayout';
import AppLayout from './layouts/AppLayout';
import LandingPage from './pages/LandingPage';
import AuthPage from './pages/AuthPage';

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

// PublicCard stays EAGER, deliberately, unlike every route above it. It sits
// outside AppLayout and therefore outside that Suspense boundary, and it is
// the first thing someone sees after tapping a physical card — spending a
// round trip on a chunk at that exact moment is the worst possible place to
// save a few KB. It also adds almost no unique weight: its dependencies
// (firebase, lucide, the ui primitives) are all in the main bundle already.
import PublicCard from './pages/PublicCard';

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <TourProvider>
              <BrowserRouter>
                <Routes>
                  {/* Public NFC card page. Deliberately outside both layouts:
                      someone who tapped a chip should land on a card, not on
                      a product's chrome. No auth gate of any kind. */}
                  <Route path="/c/:cardId" element={<PublicCard />} />

                  <Route path="/" element={<LandingLayout />}>
                    <Route index element={<LandingPage />} />
                    <Route path="login" element={<AuthPage />} />
                    <Route path="signup" element={<AuthPage />} />
                  </Route>

                  <Route path="/app" element={<AppLayout />}>
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
              </BrowserRouter>
            </TourProvider>
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    </MotionConfig>
  );
}
