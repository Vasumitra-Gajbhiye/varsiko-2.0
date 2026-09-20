import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authorize } from '../src/pilot/guard.ts';
import { assessPrice, extractMonthlyPrice, PRICE_SOURCE_URL } from '../src/pilot/pricing.ts';
import { devMandate } from '../src/pilot/demo.ts';

// All pages here are synthetic. They imitate a pricing table; none is a capture of a real page.
describe('extractMonthlyPrice', () => {
  it('reads a markdown table row', () => {
    const r = extractMonthlyPrice('| CPX31 | 4 | 8 GB | $15.00/mo |', 'cpx31');
    assert.deepEqual([r?.amount, r?.currency], [15, 'USD']);
  });

  it('handles euro symbol and decimal comma', () => {
    const r = extractMonthlyPrice('| CPX 31 | 4 vCPU | 14,99 € / month |', 'cpx31');
    assert.deepEqual([r?.amount, r?.currency], [14.99, 'EUR']);
  });

  it('skips hourly rates and prefers the monthly figure', () => {
    const r = extractMonthlyPrice('| CPX31 | €0.0240/h | €14.99/mo |', 'cpx31');
    assert.equal(r?.amount, 14.99);
  });

  it('does not treat RAM or vCPU counts as prices', () => {
    assert.equal(extractMonthlyPrice('| CPX31 | 4 vCPU | 8 GB |', 'cpx31'), null);
  });

  it('does not match a longer server name', () => {
    assert.equal(extractMonthlyPrice('| CPX311 | $9.00/mo |', 'cpx31'), null);
  });

  it('ignores out-of-band amounts as parse errors', () => {
    assert.equal(extractMonthlyPrice('| CPX31 | $0.01/mo |', 'cpx31'), null);
    assert.equal(extractMonthlyPrice('| CPX31 | $99999/mo |', 'cpx31'), null);
  });

  it('rejects a server type that is not a plain name', () => {
    assert.equal(extractMonthlyPrice('| a.* | $9/mo |', 'a.*'), null);
  });

  it('strips control characters and truncates evidence', () => {
    const r = extractMonthlyPrice('| CPX31 |\u0007\u001b[31m $15.00/mo | ' + 'x'.repeat(500), 'cpx31');
    assert.ok(r && r.evidence.length <= 120 && !/[\u0000-\u001f]/.test(r.evidence));
  });
});

describe('assessPrice: the scrape can only tighten', () => {
  it('raises the effective price when the page is higher', () => {
    const c = assessPrice('cpx31', 15.5, '| CPX31 | $40.00/mo |');
    assert.equal(c.effective_usd, 40);
  });

  it('never lowers the price when the page is cheaper', () => {
    const c = assessPrice('cpx31', 15.5, '| CPX31 | $3.00/mo |');
    assert.equal(c.effective_usd, 15.5);
    assert.equal(c.verdict, 'VERIFIED');
  });

  it('converts euros conservatively', () => {
    assert.equal(assessPrice('cpx31', 15.5, '| CPX31 | €20.00/mo |').effective_usd, 22);
  });

  it('falls back to the pinned price when the page is unusable', () => {
    const c = assessPrice('cpx31', 15.5, 'Access denied');
    assert.equal(c.verdict, 'UNVERIFIED');
    assert.equal(c.effective_usd, 15.5);
    assert.equal(assessPrice('cpx31', 15.5, null).effective_usd, 15.5);
  });
});

describe('guard: scrape URL allowlist', () => {
  it('allows only the pricing page', () => {
    assert.equal(authorize(devMandate(), 'anakin:scrape.submit', { url: PRICE_SOURCE_URL }).allow, true);
    const d = authorize(devMandate(), 'anakin:scrape.submit', { url: 'http://169.254.169.254/latest/meta-data' });
    assert.equal(!d.allow && d.code, 'URL_NOT_ALLOWED');
  });

  it('respects a mandate whose scope omits the scraper', () => {
    const m = devMandate({ scope: ['hetzner:server.create'] });
    assert.equal(!authorize(m, 'anakin:scrape.submit', { url: PRICE_SOURCE_URL }).allow, true);
  });
});
