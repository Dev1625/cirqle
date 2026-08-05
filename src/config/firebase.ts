import { initializeApp } from "firebase/app";
import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from "firebase/app-check";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import firebaseConfig from "../../firebase-applet-config.json";
import { resolveFirebaseConfig } from './firebaseConfig';

declare const __CIRQLE_DEPLOYMENT_ENV__: string;

const viteEnv: Record<string, string | undefined> =
  (
    import.meta as ImportMeta & {
      env?: Record<string, string | undefined>;
    }
  ).env ?? {};

const selectedFirebaseConfig = resolveFirebaseConfig({
  deploymentEnvironment:
    typeof __CIRQLE_DEPLOYMENT_ENV__ === 'string'
      ? __CIRQLE_DEPLOYMENT_ENV__
      : 'local',
  overrideJSON: viteEnv.VITE_FIREBASE_CONFIG_JSON,
  checkedInProductionConfig: firebaseConfig,
});

export const app = initializeApp(selectedFirebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(
  app,
  selectedFirebaseConfig.firestoreDatabaseId,
);

// App Check is activated only after the matching reCAPTCHA Enterprise site key
// is configured in the deployment environment. Keeping this opt-in lets the
// production team observe App Check metrics before enforcement without breaking
// local development or public-card visitors.
let appCheckInstance: AppCheck | null = null;

if (typeof window !== "undefined") {
  const siteKey = viteEnv.VITE_FIREBASE_APP_CHECK_SITE_KEY?.trim();
  if (siteKey) {
    const globalAny = window as typeof window & {
      __CIRQLE_APP_CHECK__?: AppCheck;
    };

    if (!globalAny.__CIRQLE_APP_CHECK__) {
      globalAny.__CIRQLE_APP_CHECK__ = initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(siteKey),
        isTokenAutoRefreshEnabled: true,
      });
    }
    appCheckInstance = globalAny.__CIRQLE_APP_CHECK__;
  }
}

export async function getFirebaseAppCheckToken(): Promise<string | null> {
  if (!appCheckInstance) return null;
  try {
    return (await getToken(appCheckInstance, false)).token;
  } catch {
    // Monitor mode must not make a public card unusable. Once server-side
    // enforcement is enabled, the endpoint returns a retryable verification
    // error instead.
    return null;
  }
}

// Opt-in local emulator wiring for development/testing only — never active
// unless VITE_USE_FIREBASE_EMULATOR is explicitly set, so production and
// normal local dev against the live project are unaffected.
//
// Ports are overridable because the defaults are not always available: with
// more than one worktree checked out, the second emulator cannot bind 9099 /
// 8085, and pointing the app at the first one silently runs it against
// another branch's firestore.rules — which fails in confusing ways rather
// than obvious ones. Set VITE_EMULATOR_AUTH_PORT / VITE_EMULATOR_FIRESTORE_PORT
// (and the matching ports in firebase.json) to run a second instance.
if (typeof window !== 'undefined' && viteEnv.VITE_USE_FIREBASE_EMULATOR === 'true') {
  const globalAny = window as any;
  if (!globalAny.__CIRQLE_EMULATOR_CONNECTED__) {
    globalAny.__CIRQLE_EMULATOR_CONNECTED__ = true;
    const host = viteEnv.VITE_EMULATOR_HOST || '127.0.0.1';
    const authPort = Number(viteEnv.VITE_EMULATOR_AUTH_PORT) || 9099;
    const firestorePort = Number(viteEnv.VITE_EMULATOR_FIRESTORE_PORT) || 8085;
    connectAuthEmulator(auth, `http://${host}:${authPort}`, { disableWarnings: true });
    connectFirestoreEmulator(db, host, firestorePort);
  }
}

export interface FirestoreErrorInfo {
  errorCode:
    | 'permission-denied'
    | 'unauthenticated'
    | 'unavailable'
    | 'resource-exhausted'
    | 'unknown';
  operationType: "create" | "update" | "delete" | "list" | "get" | "write";
  pathBucket: string;
  authState: {
    signedIn: boolean;
    emailVerified: boolean;
    isAnonymous: boolean;
  };
}

function safeFirestoreCode(error: unknown): FirestoreErrorInfo['errorCode'] {
  const raw =
    typeof (error as { code?: unknown })?.code === 'string'
      ? String((error as { code: string }).code)
          .replace(/^firestore\//, '')
          .toLowerCase()
      : '';
  return [
    'permission-denied',
    'unauthenticated',
    'unavailable',
    'resource-exhausted',
  ].includes(raw)
    ? (raw as FirestoreErrorInfo['errorCode'])
    : 'unknown';
}

function safePathBucket(path: string | null): string {
  if (!path) return 'unknown';
  const segments = path.split('/').filter(Boolean);
  if (segments[0] === 'users') {
    return segments.length < 3 ? 'profile' : segments[2].slice(0, 40);
  }
  return (segments[0] || 'unknown').slice(0, 40);
}

export function handleFirestoreError(
  error: unknown,
  operationType: FirestoreErrorInfo["operationType"],
  path: string | null
): never {
  const currentUser = auth.currentUser;

  const errorInfo: FirestoreErrorInfo = {
    errorCode: safeFirestoreCode(error),
    operationType,
    pathBucket: safePathBucket(path),
    authState: {
      signedIn: Boolean(currentUser),
      emailVerified: currentUser?.emailVerified === true,
      isAnonymous: currentUser?.isAnonymous === true,
    },
  };

  throw new Error(JSON.stringify(errorInfo));
}
