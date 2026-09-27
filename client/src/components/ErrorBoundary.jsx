import { Component } from 'react';

// Shows the fault instead of a black screen if any part of the HUD crashes.
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h1>SYSTEM FAULT</h1>
        <p>Chitti hit an internal error.</p>
        <pre>{String(this.state.error?.stack || this.state.error)}</pre>
        <button className="btn primary" onClick={() => location.reload()}>↻ REBOOT CHITTI</button>
      </div>
    );
  }
}
