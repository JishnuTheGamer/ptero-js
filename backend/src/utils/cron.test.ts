import assert from 'node:assert/strict';
import test from 'node:test';
import { getNextCronDate, matchesCron, validateCron } from './cron';

test('matchesCron matches wildcard, step, and explicit values', () => {
    const date = new Date(2026, 4, 10, 14, 30, 0); // May 10, 2026 14:30 (Sunday = 0)
    assert.equal(
        matchesCron({ minute: '*/15', hour: '14', dayOfMonth: '*', month: '5', dayOfWeek: '0' }, date),
        true
    );
    assert.equal(
        matchesCron({ minute: '0', hour: '14', dayOfMonth: '*', month: '*', dayOfWeek: '*' }, date),
        false
    );
});

test('getNextCronDate finds upcoming matching minute', () => {
    const base = new Date(2026, 4, 10, 14, 12, 0);
    const next = getNextCronDate({ minute: '*/15', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' }, base);
    assert.equal(next.getMinutes(), 15);
    assert.equal(next.getHours(), 14);
});

test('validateCron rejects invalid expressions', () => {
    assert.throws(() =>
        validateCron({ minute: '99', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' })
    );
});
