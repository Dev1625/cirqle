import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { monitorAppWebVitals } from './lib/webVitals.ts';
import { auth } from './config/firebase.ts';
import {
  configureGroundingPrivacyPolicyResolver,
} from './lib/grounding.ts';
import {
  loadSourcePrivacyPolicy,
} from './lib/moat/privacyPolicyStore.ts';

monitorAppWebVitals();
configureGroundingPrivacyPolicyResolver(async () => {
  const user = auth.currentUser;
  return user ? loadSourcePrivacyPolicy(user.uid) : null;
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
