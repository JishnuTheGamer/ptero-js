import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildJavaLaunchArgs,
    buildSafeServerJavaArgs,
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

test('buildSafeServerJavaArgs disables JLine/ANSI and caps JVM heap safely', () => {
    const args = buildSafeServerJavaArgs(
        'java -Xms128M -XX:MaxRAMPercentage=95.0 -Dterminal.jline=true -Dterminal.ansi=true -jar {{SERVER_JARFILE}} nogui',
        { SERVER_JARFILE: 'paper.jar' },
        2048,
        { disableJline: true, hostMemoryMb: 1000 }
    );
    assert.equal(args.includes('-XX:MaxRAMPercentage=95.0'), false);
    assert.equal(args.includes('-Dterminal.ansi=true'), false);
    assert.equal(args.includes('-Dterminal.jline=true'), false);
    assert.ok(args.includes('-Dterminal.jline=false'));
    assert.ok(args.includes('-Dterminal.ansi=false'));
    // host ceiling = floor(1000 * 0.85) = 850M
    assert.ok(args.includes('-Xmx850M'));
    const jlineIdx = args.indexOf('-Dterminal.jline=false');
    const jarIdx = args.indexOf('-jar');
    assert.ok(jlineIdx >= 0 && jarIdx > jlineIdx);

    const unlimited = buildSafeServerJavaArgs(
        'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui',
        { SERVER_MEMORY: 0, SERVER_JARFILE: 'paper.jar' },
        0,
        { disableJline: true }
    );
    assert.equal(unlimited.some((a) => a.startsWith('-Xmx')), false);
    assert.ok(unlimited.includes('-Dterminal.jline=false'));
    assert.ok(unlimited.includes('-Dterminal.ansi=false'));
});

test('buildSafeServerJavaArgs injects tuned G1GC flags and respects custom GC or optimizeGc=false', () => {
    const optimized = buildSafeServerJavaArgs(
        'java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui',
        { SERVER_JARFILE: 'paper.jar' },
        4096,
        { disableJline: true, hostMemoryMb: 8192 }
    );
    assert.ok(optimized.includes('-XX:+UseG1GC'));
    assert.ok(optimized.includes('-XX:+ParallelRefProcEnabled'));
    assert.ok(optimized.includes('-XX:G1HeapRegionSize=8M'));
    assert.ok(optimized.includes('-Djava.net.preferIPv4Stack=true'));
    assert.ok(optimized.includes('-Djava.security.egd=file:/dev/./urandom'));
    assert.ok(optimized.includes('-Djava.awt.headless=true'));
    assert.ok(!optimized.includes('-XX:+AlwaysPreTouch'));
    assert.ok(optimized.some((a) => a.startsWith('-Xms')));
    assert.ok(optimized.indexOf('-XX:+UseG1GC') < optimized.indexOf('-jar'));

    const customGc = buildSafeServerJavaArgs(
        'java -Xms1024M -Xmx4096M -XX:+UseZGC -jar server.jar nogui',
        {},
        4096,
        { hostMemoryMb: 8192 }
    );
    assert.ok(customGc.includes('-XX:+UseZGC'));
    assert.equal(customGc.includes('-XX:+UseG1GC'), false);

    const disabledGc = buildSafeServerJavaArgs(
        'java -Xms128M -Xmx2048M -jar server.jar nogui',
        {},
        2048,
        { optimizeGc: false, hostMemoryMb: 8192 }
    );
    assert.equal(disabledGc.includes('-XX:+UseG1GC'), false);
});

