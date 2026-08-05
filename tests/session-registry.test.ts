import assert from 'node:assert/strict';
import test from 'node:test';

import { describeCurrentDevice } from '../src/lib/sessionRegistry';

test('session activity stores coarse browser and platform labels only', () => {
  assert.deepEqual(
    describeCurrentDevice(
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
      'Win32',
    ),
    {
      browser: 'Chrome',
      platform: 'Windows',
      deviceLabel: 'Chrome · Windows',
    },
  );
  assert.deepEqual(
    describeCurrentDevice(
      'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1',
      'iPhone',
    ),
    {
      browser: 'Safari',
      platform: 'iOS',
      deviceLabel: 'Safari · iOS',
    },
  );
});
