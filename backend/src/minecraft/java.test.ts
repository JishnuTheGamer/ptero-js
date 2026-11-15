import assert from 'node:assert/strict';
import test from 'node:test';
import {
    normalizeSupportedJavaMajor,
    parseJavaVersion,
    parseRequestedJavaMajor,
    requiredJavaForMinecraft,
} from './java';

test('parseJavaVersion handles Java 8 and modern Java versions', () => {
    assert.deepEqual(parseJavaVersion('openjdk version "1.8.0_412"'), { major: 8, raw: '1.8.0_412' });
    assert.deepEqual(parseJavaVersion('openjdk version "17.0.12" 2024-07-16'), { major: 17, raw: '17.0.12' });
    assert.deepEqual(parseJavaVersion('openjdk version "21.0.4"'), { major: 21, raw: '21.0.4' });
    assert.deepEqual(parseJavaVersion('openjdk version "26.0.1"'), { major: 26, raw: '26.0.1' });
});

test('requiredJavaForMinecraft maps Minecraft versions to minimum Java versions', () => {
    assert.equal(requiredJavaForMinecraft('1.8.8'), 8);
    assert.equal(requiredJavaForMinecraft('1.16.5'), 8);
    assert.equal(requiredJavaForMinecraft('1.17.1'), 16);
    assert.equal(requiredJavaForMinecraft('1.20.4'), 17);
    assert.equal(requiredJavaForMinecraft('1.20.6'), 21);
    assert.equal(requiredJavaForMinecraft('1.21.4'), 21);
    assert.equal(requiredJavaForMinecraft('26.1'), 25);
    assert.equal(requiredJavaForMinecraft('26.3'), 25);
    assert.equal(requiredJavaForMinecraft('latest'), 25);
});

test('parseRequestedJavaMajor and normalizeSupportedJavaMajor support Java 8/11/17/21/25/26', () => {
    assert.equal(parseRequestedJavaMajor('java:8'), 8);
    assert.equal(parseRequestedJavaMajor('java:11'), 11);
    assert.equal(parseRequestedJavaMajor('java:17'), 17);
    assert.equal(parseRequestedJavaMajor('java:21'), 21);
    assert.equal(parseRequestedJavaMajor('java:25'), 25);
    assert.equal(parseRequestedJavaMajor('java:26'), 26);
    assert.equal(parseRequestedJavaMajor('java:auto'), null);

    assert.equal(normalizeSupportedJavaMajor(8), 8);
    assert.equal(normalizeSupportedJavaMajor(11), 11);
    assert.equal(normalizeSupportedJavaMajor(16), 17);
    assert.equal(normalizeSupportedJavaMajor(21), 21);
    assert.equal(normalizeSupportedJavaMajor(25), 25);
    assert.equal(normalizeSupportedJavaMajor(26), 26);
});
