import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildJavaLaunchArgs,
    buildServerStartupCommand,
    parseCommandArgs,
    renderStartupCommand,
    validateEggVariableValue,
} from './startup';

test('renderStartupCommand substitutes variables cleanly', () => {
    const cmd = renderStartupCommand('java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui', {
        SERVER_MEMORY: 2048,
        SERVER_JARFILE: 'paper.jar',
    });
    assert.equal(cmd, 'java -Xmx2048M -jar paper.jar nogui');
});

test('parseCommandArgs handles quotes without invoking shell', () => {
    const args = parseCommandArgs('java -Xmx2G -Dmotd="Hello World" -jar server.jar nogui');
    assert.deepEqual(args, ['java', '-Xmx2G', '-Dmotd=Hello World', '-jar', 'server.jar', 'nogui']);
});

test('buildJavaLaunchArgs omits -Xmx when memory is 0 (Unlimited) and enforces -Xmx when positive', () => {
    const template = 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui';
    const unlimitedArgs = buildJavaLaunchArgs(template, { SERVER_MEMORY: 0, SERVER_JARFILE: 'server.jar' }, 0);
    assert.deepEqual(unlimitedArgs, ['-Xms128M', '-jar', 'server.jar', 'nogui']);

    const limitedArgs = buildJavaLaunchArgs('java -jar {{SERVER_JARFILE}} nogui', { SERVER_MEMORY: 2048, SERVER_JARFILE: 'server.jar' }, 2048);
    assert.deepEqual(limitedArgs, ['-Xmx2048M', '-jar', 'server.jar', 'nogui']);

    const invocation = buildServerStartupCommand(template, { SERVER_MEMORY: 0, SERVER_JARFILE: 'server.jar' }, 0);
    assert.equal(invocation, 'java -Xms128M -jar server.jar nogui');
});

test('validateEggVariableValue enforces required and regex rules', () => {
    assert.ok(validateEggVariableValue('', 'required|string'));
    assert.equal(validateEggVariableValue('server.jar', 'required|regex:/^([\\w\\d._-]+)(\\.jar)$/'), null);
    assert.ok(validateEggVariableValue('bad;rm -rf /', 'required|regex:/^([\\w\\d._-]+)(\\.jar)$/'));
});
