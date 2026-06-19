'use strict';

// Force serial subtest execution in every test file. Parallel subtests that
// mutate registry/chdir/process state trigger flaky test-runner IPC
// "Unable to deserialize cloned data" failures on Node 18–22 CI runners.
const { test } = require('node:test');
if (typeof test.configure === 'function') {
  test.configure({ concurrency: 1 });
}
