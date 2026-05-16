/**
 * Tests for lib/auth.js -- timingSafeCompare, isLoopbackAddress, requireAuth.
 */
import { describe, test, expect } from '@jest/globals';
import { jest } from '@jest/globals';
import { timingSafeCompare, isLoopbackAddress, requireAuth } from '../../lib/auth.js';

describe('lib/auth', () => {
  describe('timingSafeCompare', () => {
    test('returns true for matching strings', () => {
      expect(timingSafeCompare('secret', 'secret')).toBe(true);
      expect(timingSafeCompare('abc123', 'abc123')).toBe(true);
    });

    test('returns false for non-matching strings', () => {
      expect(timingSafeCompare('secret', 'wrong')).toBe(false);
      expect(timingSafeCompare('abc', 'xyz')).toBe(false);
    });

    test('returns false for empty strings compared to non-empty', () => {
      expect(timingSafeCompare('', 'notempty')).toBe(false);
      expect(timingSafeCompare('notempty', '')).toBe(false);
    });

    test('returns true for two empty strings', () => {
      expect(timingSafeCompare('', '')).toBe(true);
    });

    test('returns false for different lengths', () => {
      expect(timingSafeCompare('short', 'muchlongerstring')).toBe(false);
      expect(timingSafeCompare('muchlongerstring', 'short')).toBe(false);
    });

    test('returns false for non-string inputs', () => {
      expect(timingSafeCompare(null, 'test')).toBe(false);
      expect(timingSafeCompare('test', null)).toBe(false);
      expect(timingSafeCompare(123, 'test')).toBe(false);
      expect(timingSafeCompare('test', 123)).toBe(false);
      expect(timingSafeCompare(undefined, undefined)).toBe(false);
      expect(timingSafeCompare(null, null)).toBe(false);
      expect(timingSafeCompare({}, [])).toBe(false);
    });

    test('handles Unicode strings', () => {
      expect(timingSafeCompare('héllo wörld', 'héllo wörld')).toBe(true);
      expect(timingSafeCompare('héllo', 'hello')).toBe(false);
      expect(timingSafeCompare('日本語', '日本語')).toBe(true);
      expect(timingSafeCompare('日本語', '中文字')).toBe(false);
    });
  });

  describe('isLoopbackAddress', () => {
    test('returns true for 127.0.0.1', () => {
      expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    });

    test('returns true for ::1', () => {
      expect(isLoopbackAddress('::1')).toBe(true);
    });

    test('returns true for ::ffff:127.0.0.1', () => {
      expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    });

    test('returns false for null', () => {
      expect(isLoopbackAddress(null)).toBe(false);
    });

    test('returns false for undefined', () => {
      expect(isLoopbackAddress(undefined)).toBe(false);
    });

    test('returns false for non-loopback IPs', () => {
      expect(isLoopbackAddress('192.168.1.1')).toBe(false);
      expect(isLoopbackAddress('10.0.0.1')).toBe(false);
      expect(isLoopbackAddress('8.8.8.8')).toBe(false);
    });

    test('returns false for empty string', () => {
      expect(isLoopbackAddress('')).toBe(false);
    });
  });

  describe('requireAuth', () => {
    function mockReq(headers = {}, remoteAddress = '127.0.0.1') {
      return {
        headers,
        socket: { remoteAddress },
      };
    }

    function mockRes() {
      const res = {
        _status: null,
        _json: null,
        status(code) { res._status = code; return res; },
        json(body) { res._json = body; return res; },
      };
      return res;
    }

    test('returns a function (middleware)', () => {
      const middleware = requireAuth({ apiKey: null, nodeEnv: 'development' });
      expect(typeof middleware).toBe('function');
    });

    test('calls next() with valid Bearer token', () => {
      const middleware = requireAuth({ apiKey: 'my-secret', nodeEnv: 'production' });
      const req = mockReq({ authorization: 'Bearer my-secret' });
      const res = mockRes();
      const next = jest.fn();

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res._status).toBeNull();
    });

    test('returns 403 with invalid Bearer token', () => {
      const middleware = requireAuth({ apiKey: 'my-secret', nodeEnv: 'production' });
      const req = mockReq({ authorization: 'Bearer wrong-token' });
      const res = mockRes();
      const next = jest.fn();

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
      expect(res._json.error).toBe('Forbidden');
    });

    test('returns 403 with missing authorization header when apiKey set', () => {
      const middleware = requireAuth({ apiKey: 'my-secret', nodeEnv: 'production' });
      const req = mockReq({});
      const res = mockRes();
      const next = jest.fn();

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    test('returns 403 with malformed authorization header', () => {
      const middleware = requireAuth({ apiKey: 'my-secret', nodeEnv: 'production' });
      const req = mockReq({ authorization: 'Basic my-secret' });
      const res = mockRes();
      const next = jest.fn();

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    test('allows loopback when no apiKey and not production', () => {
      const middleware = requireAuth({ apiKey: null, nodeEnv: 'development' });
      const req = mockReq({}, '127.0.0.1');
      const res = mockRes();
      const next = jest.fn();

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('allows loopback ::1 when no apiKey and not production', () => {
      const middleware = requireAuth({ apiKey: null, nodeEnv: 'development' });
      const req = mockReq({}, '::1');
      const res = mockRes();
      const next = jest.fn();

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('rejects non-loopback when no apiKey and not production', () => {
      const middleware = requireAuth({ apiKey: null, nodeEnv: 'development' });
      const req = mockReq({}, '192.168.1.100');
      const res = mockRes();
      const next = jest.fn();

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    test('rejects loopback in production when no apiKey', () => {
      const middleware = requireAuth({ apiKey: null, nodeEnv: 'production' });
      const req = mockReq({}, '127.0.0.1');
      const res = mockRes();
      const next = jest.fn();

      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    test('uses custom error message', () => {
      const middleware = requireAuth(
        { apiKey: null, nodeEnv: 'production' },
        { errorMessage: 'Custom rejection' }
      );
      const req = mockReq({}, '127.0.0.1');
      const res = mockRes();
      const next = jest.fn();

      middleware(req, res, next);
      expect(res._json.error).toBe('Custom rejection');
    });

    test('Bearer token match is case-insensitive for prefix', () => {
      const middleware = requireAuth({ apiKey: 'my-secret', nodeEnv: 'production' });
      const req = mockReq({ authorization: 'bearer my-secret' });
      const res = mockRes();
      const next = jest.fn();

      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
