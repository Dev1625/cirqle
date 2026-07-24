import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { MotionConfig } from 'motion/react';
import { AuthProvider } from './contexts/AuthContext';
import { TourProvider } from './contexts/TourContext';
import { ToastProvider } from './contexts/ToastContext';
import { ConfirmProvider } from './contexts/ConfirmContext';

import LandingLayout from './layouts/LandingLayout';
import AppLayout from './layouts/AppLayout';

import LandingPage from './pages/LandingPage';
import AuthPage from './pages/AuthPage';
import Dashboard from './pages/Dashboard';
import Directory from './pages/Directory';
import NetworkGraph from './pages/NetworkGraph';
import ContactDetail from './pages/ContactDetail';

import Settings from './pages/Settings';

import Tracker from './pages/Tracker';
import OutreachCalendar from './pages/OutreachCalendar';

import Templates from './pages/Templates';

// Placeholder standard pages that will be built next
const PlaceholderPage = ({ title }: { title: string }) => (
  <div><h1 className="font-serif text-3xl mb-4">{title}</h1><p className="font-mono text-subtle">Coming soon.</p></div>
);

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
    <AuthProvider>
      <ToastProvider>
        <ConfirmProvider>
          <TourProvider>
            <BrowserRouter>
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
            </BrowserRouter>
          </TourProvider>
        </ConfirmProvider>
      </ToastProvider>
    </AuthProvider>
    </MotionConfig>
  );
}
