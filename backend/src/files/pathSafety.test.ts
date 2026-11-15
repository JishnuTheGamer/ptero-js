import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatModeString, PathTraversalError, resolveServerPath } from './pathSafety';

test('resolveServerPath keeps paths inside server root and blocks traversal', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptero-path-'));
    try {
        const sub = path.join(tmp, 'plugins');
        fs.mkdirSync(sub);
        const safe = resolveServerPath(tmp, '/plugins/config.yml');
        assert.equal(safe, path.join(fs.realpathSync(tmp), 'plugins', 'config.yml'));

        // Traversal attempts clamped to root or rejected if symlink escapes
        const clamped = resolveServerPath(tmp, '../../etc/passwd');
        assert.equal(clamped, path.join(fs.realpathSync(tmp), 'etc', 'passwd'));

        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ptero-outside-'));
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
        fs.symlinkSync(outside, path.join(tmp, 'escape-link'));
        assert.throws(() => resolveServerPath(tmp, '/escape-link/secret.txt'), PathTraversalError);
        fs.rmSync(outside, { recursive: true, force: true });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('formatModeString formats unix mode bits accurately', () => {
    const res = formatModeString(0o100644, false);
    assert.equal(res.mode, '-rw-r--r--');
    assert.equal(res.modeBits, '644');
});
