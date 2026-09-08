import { spawn } from 'node:child_process';
import { join } from 'node:path';

const OUTPUT_LIMIT_BYTES = 1024 * 1024;

// Best effort cleanup for this check only. This is not a sandbox and deliberately
// does not claim control over descendants that detach or escape the process tree.
async function stopProcessTree(child) {
  if (!child.pid) return { attempted: false, confirmed: true, detail: 'No process was started.' };
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return { attempted: true, confirmed: false, detail: 'SIGKILL sent to this check process group; detached descendants and complete exit are not guaranteed.' };
    } catch (error) {
      return { attempted: true, confirmed: false, detail: `Process-group cleanup could not be confirmed (${error.code}); detached descendants may remain.` };
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const complete = (detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ attempted: true, confirmed: false, detail });
    };
    const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.on('error', (error) => complete(`Targeted taskkill could not start (${error.code}); child-process cleanup is unconfirmed.`));
    killer.on('close', (code) => complete(code === 0
      ? 'Windows taskkill /T /F completed for this check PID; detached or reparented descendants cannot be guaranteed absent.'
      : `Windows taskkill returned ${code}; child-process cleanup is unconfirmed.`));
    timer = setTimeout(() => {
      killer.kill();
      killer.unref();
      complete('Targeted taskkill exceeded its 1000 ms limit; child-process cleanup is unconfirmed.');
    }, 1000);
  });
}

export async function runCheck(check, { signal } = {}) {
  const result = {
    id: check.id, executable: check.executable, args: [...check.args], cwd: check.cwd,
    timeoutMs: check.timeoutMs, startedAt: new Date().toISOString(), finishedAt: null,
    pid: null, exitCode: null, signal: null, stdout: '', stderr: '', status: 'INCONCLUSIVE', reason: '',
    cleanup: { attempted: false, confirmed: false, detail: 'No process-tree cleanup was requested.' },
  };
  if (signal?.aborted) {
    result.reason = 'Check interrupted before start: abort requested.';
    result.cleanup = { attempted: false, confirmed: true, detail: 'No process was started.' };
    result.finishedAt = new Date().toISOString();
    return result;
  }
  return new Promise((resolve) => {
    let spawnError;
    let timer;
    let finished = false;
    let stopping = false;
    let capturedBytes = 0;
    const captured = { stdout: [], stderr: [] };
    let child;
    const onAbort = () => { void stop('Check interrupted: abort requested.'); };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      result.stdoutBytes = Buffer.concat(captured.stdout);
      result.stderrBytes = Buffer.concat(captured.stderr);
      result.stdout = result.stdoutBytes.toString('utf8');
      result.stderr = result.stderrBytes.toString('utf8');
      result.finishedAt = new Date().toISOString();
      resolve(result);
    };
    try {
      child = spawn(check.executable, check.args, {
        cwd: check.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      result.pid = child.pid ?? null;
    } catch (error) {
      result.reason = `Could not start check: ${error.code || error.name}: ${error.message}`;
      result.cleanup = { attempted: false, confirmed: true, detail: 'No process was started.' };
      finish();
      return;
    }
    const stop = async (reason) => {
      if (finished || stopping) return;
      stopping = true;
      result.status = 'INCONCLUSIVE';
      result.reason = reason;
      try { result.cleanup = await stopProcessTree(child); }
      catch (error) { result.cleanup = { attempted: true, confirmed: false, detail: `Tree cleanup failed: ${error.code ?? error.message}.` }; }
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        await new Promise(resolveStopped => {
          let done = false;
          const stopped = () => {
            if (done) return;
            done = true;
            clearTimeout(waitTimer);
            child.removeListener('exit', stopped);
            resolveStopped();
          };
          const waitTimer = setTimeout(stopped, 500);
          child.once('exit', stopped);
          try { child.kill('SIGKILL'); }
          catch (error) { result.cleanup.detail += ` Direct child termination failed: ${error.code ?? error.message}.`; }
        });
        result.cleanup.detail += ' Direct termination fallback targeted only this child handle.';
      }
      result.cleanup.directProcessStopped = !child.pid || child.exitCode !== null || child.signalCode !== null;
      result.cleanup.detail += result.cleanup.directProcessStopped ? ' Direct child exit was observed; descendant cleanup is still unconfirmed.' : ' Direct child exit could not be confirmed.';
      finish();
    };
    timer = setTimeout(() => { void stop(`Check timed out after ${check.timeoutMs} ms.`); }, check.timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const capture = (stream, data) => {
      if (finished) return;
      const remaining = OUTPUT_LIMIT_BYTES - capturedBytes;
      const retained = data.subarray(0, remaining);
      if (retained.length) captured[stream].push(retained);
      capturedBytes += retained.length;
      if (data.length > remaining) void stop(`Combined output exceeded the ${OUTPUT_LIMIT_BYTES} byte capture limit; evidence logs are truncated.`);
    };
    child.stdout.on('data', (data) => capture('stdout', data));
    child.stderr.on('data', (data) => capture('stderr', data));
    child.on('exit', (code, exitSignal) => {
      if (finished) return;
      result.exitCode = code;
      result.signal = exitSignal;
    });
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code, exitSignal) => {
      if (finished) return;
      result.exitCode = spawnError ? null : code;
      result.signal = exitSignal;
      if (stopping) return;
      result.status = spawnError || exitSignal ? 'INCONCLUSIVE' : (check.passExitCodes.includes(code) ? 'PASSED' : 'FAILED');
      result.reason = spawnError ? `Could not start check: ${spawnError.code}: ${spawnError.message}`
        : exitSignal ? `Check terminated by signal ${exitSignal}.`
          : `Process exited with code ${code}; accepted exit codes: ${check.passExitCodes.join(', ')}.`;
      finish();
    });
  });
}
