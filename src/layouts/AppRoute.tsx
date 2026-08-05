import AppLayout from './AppLayout';
import { TourProvider } from '../contexts/TourContext';

/**
 * Route boundary for authenticated-only infrastructure. Keeping the provider
 * here prevents tour and app-shell code from entering the public landing
 * bundle while preserving router context for tour navigation.
 */
export default function AppRoute() {
  return (
    <TourProvider>
      <AppLayout />
    </TourProvider>
  );
}
