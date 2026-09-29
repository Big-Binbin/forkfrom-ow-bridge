import fs from 'node:fs/promises';

// Replacing a path that another process still holds is a Windows-specific failure: the POSIX
// rename is atomic and unconditional, while Windows refuses the replacement with EPERM/EACCES/
// EBUSY when the destination is open without delete sharing (antivirus real-time scanning, sync
// clients, an editor, or the reader of the configuration being rewritten) or mapped as a running
// image. Those conflicts are short-lived, so retry briefly instead of failing the write.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const DELAYS = [50, 100, 200, 400, 800];

export async function replaceWithRetry(temp, target, { rename = fs.rename, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), delays = DELAYS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(temp, target); }
    catch (error) {
      if (!TRANSIENT.has(error.code) || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}
