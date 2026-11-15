import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
    let bits = 0;
    let value = 0;
    let output = '';

    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }

    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }

    return output;
}

export function base32Decode(input: string): Buffer {
    const normalized = input.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];

    for (const char of normalized) {
        const idx = BASE32_ALPHABET.indexOf(char);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }

    return Buffer.from(bytes);
}

export function generateTotpSecret(byteLength = 20): string {
    return base32Encode(crypto.randomBytes(byteLength));
}

export function generateTotpCode(secret: string, timestampMs = Date.now(), periodSec = 30, digits = 6): string {
    const key = base32Decode(secret);
    const counter = Math.floor(timestampMs / 1000 / periodSec);
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuf.writeUInt32BE(counter >>> 0, 4);

    const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const codeInt =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);

    return String(codeInt % 10 ** digits).padStart(digits, '0');
}

export function verifyTotpCode(secret: string, token: string, windowSteps = 1, timestampMs = Date.now()): boolean {
    const cleaned = token.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleaned)) {
        return false;
    }

    for (let offset = -windowSteps; offset <= windowSteps; offset++) {
        const expected = generateTotpCode(secret, timestampMs + offset * 30_000);
        if (crypto.timingSafeEqual(Buffer.from(cleaned), Buffer.from(expected))) {
            return true;
        }
    }
    return false;
}

export function buildTotpUri(issuer: string, accountEmail: string, secret: string): string {
    const label = encodeURIComponent(`${issuer}:${accountEmail}`);
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: '6',
        period: '30',
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

export function generateRecoveryTokens(count = 8): string[] {
    const tokens: string[] = [];
    for (let i = 0; i < count; i++) {
        const left = crypto.randomBytes(3).toString('hex');
        const right = crypto.randomBytes(3).toString('hex');
        tokens.push(`${left}-${right}`);
    }
    return tokens;
}
