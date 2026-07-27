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
// Each becomes its own chunk, fetched on navigation.
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
            {/* TourProvider sits *inside* BrowserRouter: tours navigate
                between pages themselves (see the `route` on each step), which
                means they need the router context. */}
            <BrowserRouter>
              <TourProvider>
                <Routes>
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
              </TourProvider>
            </BrowserRouter>
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    </MotionConfig>
  );
}
