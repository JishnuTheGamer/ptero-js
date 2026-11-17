import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeServerProperties } from './software';

test('writeServerProperties writes chunk and join performance defaults for new servers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptero-props-'));
    try {
        writeServerProperties(tmpDir, 25575, 'Fast Server');
        const content = fs.readFileSync(path.join(tmpDir, 'server.properties'), 'utf8');
        assert.match(content, /^server-port=25575$/m);
        assert.match(content, /^view-distance=8$/m);
        assert.match(content, /^simulation-distance=6$/m);
        assert.match(content, /^sync-chunk-writes=false$/m);
        assert.match(content, /^network-compression-threshold=256$/m);
        assert.match(content, /^use-native-transport=true$/m);
        assert.match(content, /^entity-broadcast-range-percentage=80$/m);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('writeServerProperties preserves user settings and skips unchanged rewrites', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptero-props-keep-'));
    const propsPath = path.join(tmpDir, 'server.properties');
    try {
        fs.writeFileSync(
            propsPath,
            [
                'server-ip=127.0.0.1',
                'server-port=25565',
                'query.port=25565',
                'view-distance=12',
                'simulation-distance=10',
                'sync-chunk-writes=true',
                '',
            ].join('\n')
        );

        writeServerProperties(tmpDir, 25570, 'My Server');
        const updated = fs.readFileSync(propsPath, 'utf8');
        assert.match(updated, /^server-ip=0\.0\.0\.0$/m);
        assert.match(updated, /^server-port=25570$/m);
        assert.match(updated, /^query\.port=25570$/m);
        assert.match(updated, /^view-distance=12$/m);
        assert.match(updated, /^simulation-distance=10$/m);
        assert.match(updated, /^sync-chunk-writes=true$/m);
        assert.match(updated, /^use-native-transport=true$/m);

        const beforeStat = fs.statSync(propsPath);
        writeServerProperties(tmpDir, 25570, 'My Server');
        const afterStat = fs.statSync(propsPath);
        assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
