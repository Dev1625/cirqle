export interface FirebaseAuthActionRequest {
  mode: string | null;
  code: string;
}

interface AuthActionBrowser {
  href: string;
  history: Pick<History, 'state' | 'replaceState'>;
}

const EMPTY_ACTION: FirebaseAuthActionRequest = Object.freeze({
  mode: null,
  code: '',
});

/**
 * Capture Firebase's one-time action code into memory and remove it from the
 * current browser-history entry. The code is never copied into history state.
 */
export function captureFirebaseAuthAction({
  href,
  history,
}: AuthActionBrowser): FirebaseAuthActionRequest {
  const url = new URL(href);
  const actionPath = url.pathname.replace(/\/+$/, '') || '/';
  if (actionPath !== '/auth/action') return EMPTY_ACTION;

  const request = Object.freeze({
    mode: url.searchParams.get('mode'),
    code: url.searchParams.get('oobCode') || '',
  });

  if (url.searchParams.has('oobCode')) {
    url.searchParams.delete('oobCode');
    history.replaceState(
      history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }

  return request;
}
