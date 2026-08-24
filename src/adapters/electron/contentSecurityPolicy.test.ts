import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  contentSecurityPolicyMetaTag,
} from './contentSecurityPolicy';

const directives = (policy: string): Map<string, string> =>
  new Map(
    policy.split('; ').map((entry) => {
      const [directive, ...values] = entry.split(' ');
      return [directive, values.join(' ')];
    }),
  );

describe('contentSecurityPolicy', () => {
  it('forbids inline, remote, and eval script', () => {
    const policy = directives(contentSecurityPolicy({ isDev: false }));
    // The directive that matters: a form field value must never be able to
    // become executable content.
    expect(policy.get('script-src')).toBe("'self'");
    expect(policy.get('default-src')).toBe("'self'");
    expect(policy.get('object-src')).toBe("'none'");
    expect(policy.get('frame-src')).toBe("'none'");
    expect(policy.get('base-uri')).toBe("'none'");
    expect(policy.get('form-action')).toBe("'none'");
  });

  it('keeps the renderer off the network in production', () => {
    const policy = directives(contentSecurityPolicy({ isDev: false }));
    // Chain and file work happen in main and the worker, never here.
    expect(policy.get('connect-src')).toBe("'self'");
  });

  // Development running under the production script rules is the whole point of
  // this shape: a CSP violation shows up while developing rather than only in a
  // packaged build nobody tests interactively.
  it('applies the same script rules in development', () => {
    const development = contentSecurityPolicy({
      isDev: true,
      devServerOrigin: 'http://localhost:5173',
    });
    expect(directives(development).get('script-src')).toBe("'self'");
    expect(development).not.toContain('unsafe-eval');
    expect(development).not.toContain("script-src 'self' http");
  });

  it('opens only the HMR websocket in development', () => {
    const development = directives(
      contentSecurityPolicy({ isDev: true, devServerOrigin: 'http://localhost:5173' }),
    );
    expect(development.get('connect-src')).toBe("'self' ws://localhost:5173");
  });

  it('never carries a dev allowance into a production policy', () => {
    // Even given an origin, production must ignore it.
    const policy = contentSecurityPolicy({
      isDev: false,
      devServerOrigin: 'http://localhost:5173',
    });
    expect(policy).not.toContain('localhost');
    expect(policy).not.toContain('ws:');
  });

  it('allows inline style, since the shell styles are inline', () => {
    for (const isDev of [true, false]) {
      expect(directives(contentSecurityPolicy({ isDev })).get('style-src')).toBe(
        "'self' 'unsafe-inline'",
      );
    }
  });
});

describe('contentSecurityPolicyMetaTag', () => {
  it('produces a well-formed tag carrying the policy', () => {
    const tag = contentSecurityPolicyMetaTag({ isDev: false });
    expect(tag).toBe(
      `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy({
        isDev: false,
      })}" />`,
    );
  });

  it('produces a policy that needs no attribute escaping', () => {
    // The tag is built by string concatenation, so a quote or angle bracket in
    // the policy would break out of the attribute.
    for (const isDev of [true, false]) {
      const policy = contentSecurityPolicy({ isDev, devServerOrigin: 'http://localhost:5173' });
      expect(policy).not.toMatch(/["<>&]/);
    }
  });
});
