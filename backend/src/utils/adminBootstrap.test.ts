import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInitialAdminCredentials } from './adminBootstrap';

test('resolveInitialAdminCredentials falls back to safe defaults and generates a random password', () => {
    const first = resolveInitialAdminCredentials({});
    const second = resolveInitialAdminCredentials({});

    assert.equal(first.email, 'admin@ptero.local');
    assert.equal(first.username, 'admin');
    assert.equal(first.generatedPassword, true);
    assert.ok(first.password.length >= 12);
    assert.notEqual(first.password, second.password);
});

test('resolveInitialAdminCredentials respects explicit environment overrides', () => {
    const creds = resolveInitialAdminCredentials({
        ADMIN_EMAIL: '  owner@jtgstudio.dev ',
        ADMIN_USERNAME: ' JishnuAdmin ',
        ADMIN_PASSWORD: 'MyStrongPassword!99',
    });

    assert.equal(creds.email, 'owner@jtgstudio.dev');
    assert.equal(creds.username, 'jishnuadmin');
    assert.equal(creds.password, 'MyStrongPassword!99');
    assert.equal(creds.generatedPassword, false);
});
