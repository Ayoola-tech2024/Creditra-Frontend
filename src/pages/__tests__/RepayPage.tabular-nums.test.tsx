import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RepayPage from '../RepayPage';

vi.mock('@/data/mockData', () => ({
  MOCK_CREDIT_LINES: [
    {
      id: 'CL-2024-001',
      name: 'Primary Business Line',
      status: 'Active',
      limit: 500000,
      utilized: 187500,
      apr: 8.5,
      riskScore: 720,
      collateral: 'Commercial Real Estate',
      openedAt: '2024-03-15',
      updatedAt: '2025-02-20T14:32:00Z',
      nextPaymentDate: '2025-03-01',
      nextPaymentAmount: 3200,
      transactions: [],
      statusHistory: [],
    },
  ],
}));

function renderRepay(line = 'CL-2024-001') {
  return render(
    <MemoryRouter initialEntries={[`/repay?line=${line}`]}>
      <RepayPage />
    </MemoryRouter>,
  );
}

describe('RepayPage — tabular-nums (FWC26 #816)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('preset 25/50/75% buttons render percentage inside a .num-tabular span', () => {
    renderRepay();
    for (const pct of [25, 50, 75]) {
      const span = screen.getByText(`${pct}%`);
      expect(span).not.toBeNull();
      expect(span.classList.contains('num-tabular')).toBe(true);
      // The 25/50/75 preset shares rp-preset-btn — sanity
      expect(span.closest('button')).toHaveClass('rp-preset-btn');
    }
  });

  it('current debt and limit/remaining figures use num-tabular', () => {
    renderRepay();
    const debts = screen.getAllByText('$187,500.00');
    expect(debts.length).toBeGreaterThanOrEqual(1);
    for (const debt of debts) {
      expect(debt.closest('.num-tabular') ?? debt.parentElement?.closest('.num-tabular')).not.toBeNull();
    }
    const pctSpans = Array.from(document.querySelectorAll('.num-tabular')).filter(
      (el) => el.textContent === '38%',
    );
    expect(pctSpans.length).toBeGreaterThanOrEqual(1);
  });

  it('amount input carries num-tabular for digit stability', () => {
    renderRepay();
    const input = screen.getByRole('spinbutton', { name: /amount to repay/i });
    expect(input).toHaveClass('num-tabular');
  });

  it('typography utility defines .num-tabular with tabular-nums (CSS source assertion)', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync('src/styles/typography.css', 'utf-8');
    expect(css).toContain('.num-tabular');
    expect(css).toContain('font-variant-numeric: tabular-nums');
    expect(css).toContain('font-feature-settings');
  });
});
