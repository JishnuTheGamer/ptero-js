import assert from 'node:assert/strict';
import test from 'node:test';
import {
    base32Decode,
    base32Encode,
    buildTotpUri,
    generateRecoveryTokens,
    generateTotpCode,
    generateTotpSecret,
    verifyTotpCode,
} from './totp';

test('base32 roundtrip preserves bytes', () => {
    const raw = Buffer.from('Pterodactyl2FA!');
    const encoded = base32Encode(raw);
    assert.deepEqual(base32Decode(encoded), raw);
});

test('TOTP code generation and verification work within time window', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = generateTotpCode(secret, now);
    assert.match(code, /^\d{6}$/);
    assert.equal(verifyTotpCode(secret, code, 1, now), true);
    assert.equal(verifyTotpCode(secret, code, 1, now + 30_000), true);
    assert.equal(verifyTotpCode(secret, '000000', 0, now), code === '000000');
});

test('buildTotpUri produces valid otpauth URI', () => {
    const uri = buildTotpUri('Pterodactyl', 'admin@example.com', 'JBSWY3DPEHPK3PXP');
    assert.ok(uri.startsWith('otpauth://totp/'));
    assert.ok(uri.includes('secret=JBSWY3DPEHPK3PXP'));
});

test('generateRecoveryTokens returns requested unique tokens', () => {
    const tokens = generateRecoveryTokens(8);
    assert.equal(tokens.length, 8);
    assert.equal(new Set(tokens).size, 8);
});
