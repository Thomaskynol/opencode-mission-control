import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectOMO, describeOmoAvailability, OMO_RUNTIME_LIMITATION } from '../../src/lib/omo';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('OMO Detector', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'omo-test-'));
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should detect OMO when local opencode.json has oh-my-opencode plugin', async () => {
    const config = {
      plugin: ['oh-my-opencode', 'opencode-mission-control'],
    };
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(localPath, JSON.stringify(config));

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.detected).toBe(true);
    expect(status.configSource).toBe('local');
  });

  it('should not detect OMO when local opencode.json lacks oh-my-opencode', async () => {
    const config = {
      plugin: ['opencode-mission-control'],
    };
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(localPath, JSON.stringify(config));

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.detected).toBe(false);
    expect(status.configSource).toBeNull();
  });

  it('should not detect OMO when opencode.json does not exist', async () => {
    const status = await detectOMO(join(testDir, 'opencode.json'), '/nonexistent/global.json');

    expect(status.detected).toBe(false);
    expect(status.configSource).toBeNull();
  });

  it('should not detect OMO when opencode.json has no plugin array', async () => {
    const config = {
      name: 'test',
    };
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(localPath, JSON.stringify(config));

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.detected).toBe(false);
    expect(status.configSource).toBeNull();
  });

  it('should not detect OMO when opencode.json is invalid JSON', async () => {
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(localPath, 'invalid json {');

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.detected).toBe(false);
    expect(status.configSource).toBeNull();
  });

  it('should return null sisyphusPath when .sisyphus does not exist', async () => {
    const config = {
      plugin: ['oh-my-opencode'],
    };
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(localPath, JSON.stringify(config));

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.sisyphusPath).toBeNull();
  });

  it('should return sisyphusPath when .sisyphus exists', async () => {
    const config = {
      plugin: ['oh-my-opencode'],
    };
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(localPath, JSON.stringify(config));
    mkdirSync(join(testDir, '.sisyphus'), { recursive: true });

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.sisyphusPath).toBe(join(testDir, '.sisyphus'));
  });

  it('should prefer local config over global config', async () => {
    const config = {
      plugin: ['oh-my-opencode'],
    };
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(localPath, JSON.stringify(config));

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.configSource).toBe('local');
  });

  it('should handle empty plugin array', async () => {
    const config = {
      plugin: [],
    };
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(localPath, JSON.stringify(config));

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.detected).toBe(false);
  });

  it('should handle plugin array with multiple entries', async () => {
    const config = {
      plugin: ['plugin-a', 'oh-my-opencode', 'plugin-b'],
    };
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(localPath, JSON.stringify(config));

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.detected).toBe(true);
    expect(status.configSource).toBe('local');
  });

  it('should detect OMO with real user config (plugins plural + slim@version)', async () => {
    const config = {
      plugins: ['oh-my-opencode-slim@3.0.4', 'opencode-mission-control'],
    };
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(localPath, JSON.stringify(config));

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.detected).toBe(true);
    expect(status.configSource).toBe('local');
  });

  it('should detect OMO with oh-my-openagent entry', async () => {
    const config = {
      plugins: ['oh-my-openagent', 'opencode-mission-control'],
    };
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(localPath, JSON.stringify(config));

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.detected).toBe(true);
    expect(status.configSource).toBe('local');
  });

  it('should resolve sisyphusPath from localPath directory', async () => {
    mkdirSync(join(testDir, 'sub'), { recursive: true });
    mkdirSync(join(testDir, 'sub', '.sisyphus'), { recursive: true });
    const localPath = join(testDir, 'sub', 'opencode.json');
    await Bun.write(localPath, JSON.stringify({ plugins: ['oh-my-openagent'] }));

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.detected).toBe(true);
    expect(status.sisyphusPath).toBe(join(testDir, 'sub', '.sisyphus'));
  });

  it('should detect real global config shape (plugins plural + slim@version + default_agent + JSONC + http URL)', async () => {
    // Replica fiel de ~/.config/opencode/opencode.json (somente leitura):
    // chave "plugins" no plural, pin "@3.0.4", sufixo -slim, default_agent
    // orchestrator, comentários JSONC e baseURL com http:// (não é comentário).
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(
      localPath,
      `{
  "$schema": "https://opencode.ai/config.json",
  // Local plugins are auto-discovered from ./plugins/
  "plugins": [
    "@tarquinen/opencode-dcp@3.2.0",
    "@dietrichgebert/ponytail@5.3.2",
    "oh-my-opencode-slim@3.0.4",
  ],
  // v2: pin the agent used when no session agent is selected
  "default_agent": "orchestrator",
  "provider": { "llamacpp": { "options": { "baseURL": "http://127.0.0.1:8080/v1" } } },
}`,
    );

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.detected).toBe(true);
    expect(status.configSource).toBe('local');
    expect(status.loaded).toBe('unknown');
    expect(status.used).toBe(false);
  });

  it('should reject real absence (plugins plural sem OMO)', async () => {
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(
      localPath,
      JSON.stringify({
        plugins: ['@tarquinen/opencode-dcp@3.2.0', 'opencode-mission-control'],
        default_agent: 'orchestrator',
      }),
    );

    const status = await detectOMO(localPath, '/nonexistent/global.json');

    expect(status.detected).toBe(false);
    expect(status.configSource).toBeNull();
    expect(status.loaded).toBe('unknown');
    expect(status.used).toBe(false);
  });

  it('should describe disponível/carregado/utilizado without claiming load or use', async () => {
    const localPath = join(testDir, 'opencode.json');
    await Bun.write(localPath, JSON.stringify({ plugins: ['oh-my-opencode-slim@3.0.4'] }));
    const found = await detectOMO(localPath, '/nonexistent/global.json');
    const missing = await detectOMO(join(testDir, 'missing.json'), '/nonexistent/global.json');

    const foundLine = describeOmoAvailability(found);
    expect(foundLine).toContain('disponível: detectado');
    expect(foundLine).toContain('carregado: sem evidência runtime');
    expect(foundLine).toContain('utilizado: não');

    const missingLine = describeOmoAvailability(missing);
    expect(missingLine).toContain('disponível: não detectado');
    expect(missingLine).toContain('carregado: sem evidência runtime');
    expect(missingLine).toContain('utilizado: não');

    expect(OMO_RUNTIME_LIMITATION).toContain('GET /config');
    expect(OMO_RUNTIME_LIMITATION).toContain('messages[].agent');
  });
});
