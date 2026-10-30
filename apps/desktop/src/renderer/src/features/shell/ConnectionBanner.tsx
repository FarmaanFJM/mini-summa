import { Button, Icon, Spinner } from '../../ui';
import { useApp, useRuntime } from '../../app/runtime';

/**
 * Says so, at the top of the window, whenever what is on screen may be out of date. A live-looking screen that has
 * stopped updating is the worst lie this app could tell, so the banner stays until the stream is back and reloaded.
 */
export function ConnectionBanner() {
  const connection = useApp((s) => s.connection);
  const loaded = useApp((s) => s.loaded);
  const loadError = useApp((s) => s.loadError);
  const { api, loader } = useRuntime();

  if (connection === 'reconnecting') {
    return (
      <div className="ms-banner" role="status">
        <Icon name="warning" className="ms-banner__icon" />
        <span className="ms-banner__text">Connection to Mini-Summa lost. Reconnecting.</span>
        {loaded ? <span className="ms-banner__sub">Showing the last known state.</span> : null}
        <Spinner />
      </div>
    );
  }
  if (connection === 'syncing') {
    return (
      <div className="ms-banner" role="status">
        <Spinner />
        <span className="ms-banner__text">Reconnected. Updating.</span>
      </div>
    );
  }
  if (connection === 'closed') {
    return (
      <div className="ms-banner" role="status">
        <Icon name="warning" className="ms-banner__icon" />
        <span className="ms-banner__text">The connection to Mini-Summa was closed.</span>
        <Button size="sm" onClick={() => api.events.connect()}>Reconnect</Button>
      </div>
    );
  }
  if (loadError && loaded) {
    return (
      <div className="ms-banner" role="status">
        <Icon name="warning" className="ms-banner__icon" />
        <span className="ms-banner__text">Could not refresh from Mini-Summa.</span>
        <span className="ms-banner__sub">Showing the last known state.</span>
        <Button size="sm" onClick={() => { void loader.reload(); }}>Try again</Button>
      </div>
    );
  }
  return null;
}
