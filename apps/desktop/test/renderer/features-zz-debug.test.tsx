import { screen } from '@testing-library/react';
import { ApiError } from '@minisumma/shared';
import { it } from 'vitest';
import { renderFeature, textOf } from './features-helpers';

it('debug load error', async () => {
  const app = await renderFeature({ route: { reportId: 'rpt_gm_1' }, view: 'workspace' });
  app.demoState.failNext.set('reports.get', new ApiError(500, 'boom', 'The database is locked.'));
  app.runtime.route.getState().go({ view: 'reports', reportId: 'rpt_gm_1' });
  await new Promise((r) => setTimeout(r, 200));
  console.log('ROUTE', JSON.stringify(app.runtime.route.getState().view), JSON.stringify(app.runtime.route.getState().reportId));
  console.log('MAIN', textOf(document.querySelector('.ms-main')).slice(0, 600));
});
