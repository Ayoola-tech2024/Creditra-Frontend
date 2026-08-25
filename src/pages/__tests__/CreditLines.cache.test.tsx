import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import CreditLines from '../CreditLines';
import {
  resetBackendMirror,
  fetchAuthoritativeLines,
} from '../../services/creditLineAdminService';
import type { LineStatusChangeCode } from '../../services/creditLineAdminService';
import { creditLineCache } from '../../state/creditLineCache';

// Hoisted override so individual tests can force a rejected submission while
// the rest of the simulated backend (mirror + authoritative reads) stays real.
const submitOverride = vi.hoisted(() => ({
  outcome: null as null | { kind: 'rejected'; code: LineStatusChangeCode },
}));

vi.mock('../../services/creditLineAdminService', async () => {
  const actual = await vi.importActual<
    typeof import('../../services/creditLineAdminService')
  >('../../services/creditLineAdminService');
  return {
    ...actual,
    submitLineStatusChange: (
      request: Parameters<typeof actual.submitLineStatusChange>[0],
    ) =>
      actual.submitLineStatusChange(
        request,
        submitOverride.outcome ? { outcome: submitOverride.outcome } : {},
      ),
  };
});

const REFRESH_INDICATOR_TEXT = 'Updating balances from the ledger…';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetBackendMirror();
  creditLineCache.reset();
});

afterEach(() => {
  submitOverride.outcome = null;
  vi.useRealTimers();
});

function renderPage() {
  render(
    <BrowserRouter>
      <CreditLines defaultLoading={false} />
    </BrowserRouter>,
  );
  act(() => {
    vi.advanceTimersByTime(1000);
  });
}

function clickRowAction(lineName: string, action: 'Freeze' | 'Unfreeze') {
  act(() => {
    fireEvent.click(screen.getByLabelText(`Menu for ${lineName}`));
  });
  act(() => {
    fireEvent.click(screen.getByText(action));
  });
}

function primaryCard(): HTMLElement {
  return screen
    .getByLabelText('Select Primary Business Line for comparison')
    .closest('.cl-card') as HTMLElement;
}

describe('CreditLines optimistic cache flow (issue #919)', () => {
  it('applies a freeze optimistically before any network activity resolves', () => {
    renderPage();

    clickRowAction('Primary Business Line', 'Freeze');

    expect(
      within(primaryCard()).getByText('Frozen'),
    ).toBeInTheDocument();
    expect(screen.queryByText(REFRESH_INDICATOR_TEXT)).not.toBeInTheDocument();
  }, 20000);

  it('shows the indexing indicator during authoritative refresh and keeps the confirmed status', async () => {
    renderPage();
    clickRowAction('Primary Business Line', 'Freeze');

    // Submit round-trip is 900ms; afterwards the targeted refresh starts.
    await act(async () => {
      vi.advanceTimersByTime(950);
    });
    expect(screen.getByText(REFRESH_INDICATOR_TEXT)).toBeInTheDocument();

    // Authoritative read lands ~450ms after the refresh started.
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(
      screen.queryByText(REFRESH_INDICATOR_TEXT),
    ).not.toBeInTheDocument();
    expect(within(primaryCard()).getByText('Frozen')).toBeInTheDocument();
  }, 20000);

  it('rolls back exactly once with a restore announcement when the write is rejected', async () => {
    renderPage();
    const liveRegion = document.getElementById('cl-live-region');
    submitOverride.outcome = { kind: 'rejected', code: 'network_error' };

    clickRowAction('Primary Business Line', 'Freeze');
    expect(within(primaryCard()).getByText('Frozen')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1200);
    });

    expect(liveRegion?.textContent).toBe(
      'Could not save the change to Primary Business Line. Previous balance restored.',
    );
    expect(within(primaryCard()).getByText('Active')).toBeInTheDocument();
    // A rejected write never reaches the refresh phase.
    expect(
      screen.queryByText(REFRESH_INDICATOR_TEXT),
    ).not.toBeInTheDocument();
  }, 20000);

  it('persists freeze then unfreeze through the backend mirror', async () => {
    renderPage();

    clickRowAction('Primary Business Line', 'Freeze');
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });

    let mirroredStatus = '';
    await act(async () => {
      const pending = fetchAuthoritativeLines(['CL-2024-001'], {
        delayMs: 0,
      }).then((snapshot) => {
        mirroredStatus = snapshot.lines[0].status;
      });
      vi.advanceTimersByTime(1);
      await pending;
    });
    expect(mirroredStatus).toBe('Frozen');

    clickRowAction('Primary Business Line', 'Unfreeze');
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });

    await act(async () => {
      const pending = fetchAuthoritativeLines(['CL-2024-001'], {
        delayMs: 0,
      }).then((snapshot) => {
        mirroredStatus = snapshot.lines[0].status;
      });
      vi.advanceTimersByTime(1);
      await pending;
    });
    expect(mirroredStatus).toBe('Active');
  }, 20000);

  it('leaves unrelated lines untouched through a full freeze cycle', async () => {
    renderPage();
    const expansionCard = screen
      .getByLabelText('Select Expansion Capital Line for comparison')
      .closest('.cl-card') as HTMLElement;
    const before = expansionCard.textContent;

    clickRowAction('Primary Business Line', 'Freeze');
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });

    expect(expansionCard.textContent).toBe(before);
    expect(within(expansionCard).getByText('Active')).toBeInTheDocument();
  }, 20000);
});

