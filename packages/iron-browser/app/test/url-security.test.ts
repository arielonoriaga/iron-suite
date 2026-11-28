import { describe, expect, test } from 'bun:test';
import { normalizeUrl } from '../src/shared/url';

describe('normalizeUrl security boundaries', () => {
  test('accepts http, https, about:blank, and localhost shorthands', () => {
    expect(normalizeUrl('https://example.com/path?a=1')).toBe('https://example.com/path?a=1');
    expect(normalizeUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
    expect(normalizeUrl('localhost:5173/app')).toBe('http://localhost:5173/app');
    expect(normalizeUrl('sub.localhost:4000/test')).toBe('http://sub.localhost:4000/test');
    expect(normalizeUrl('10.0.0.5')).toBe('http://10.0.0.5/');
    expect(normalizeUrl('100.115.123.12:4179')).toBe('http://100.115.123.12:4179/');
    expect(normalizeUrl('192.168.1.50:3000/api?x=1')).toBe('http://192.168.1.50:3000/api?x=1');
    expect(normalizeUrl('[::1]:8080/test')).toBe('http://[::1]:8080/test');
    expect(normalizeUrl('mydevbox:8080/health')).toBe('http://mydevbox:8080/health');
    expect(normalizeUrl('mybox.local:3000')).toBe('http://mybox.local:3000/');
    expect(normalizeUrl('dev.ts.net:4179')).toBe('http://dev.ts.net:4179/');
    expect(normalizeUrl('dev.ts.net')).toBe('https://dev.ts.net/');
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
    expect(normalizeUrl('sub.example.com:8443/v1')).toBe('https://sub.example.com:8443/v1');
    expect(normalizeUrl('999.999.999.999').startsWith('http://999.999')).toBe(false);
    expect(normalizeUrl('about:blank')).toBe('about:blank');
    expect(normalizeUrl('')).toBe('about:blank');
  });

  test('rejects file:, data:, javascript:, chrome:, and devtools: schemes', () => {
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow('Unsupported URL scheme');
    expect(() => normalizeUrl('data:text/html,<script>alert(1)</script>')).toThrow(
      'Unsupported URL scheme',
    );
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow('Unsupported URL scheme');
    expect(() => normalizeUrl('chrome://settings')).toThrow('Unsupported URL scheme');
    expect(() => normalizeUrl('devtools://devtools/bundled/inspector.html')).toThrow(
      'Unsupported URL scheme',
    );
  });
});
