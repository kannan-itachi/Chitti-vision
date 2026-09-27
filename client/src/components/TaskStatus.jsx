import { useStore } from '../store';
import { answerConfirmation } from '../lib/agent';

const ICON = { pending: '○', running: '◌', done: '✔', failed: '✘', confirm: '?', cancelled: '–' };

// Small HUD strip above the command bar: current task steps, and yes/no for sensitive actions.
export default function TaskStatus() {
  const task = useStore((s) => s.task);
  const confirm = useStore((s) => s.confirm);
  const location = useStore((s) => s.session.location);
  if (!task && !confirm) return null;

  return (
    <div className={`task-status${confirm ? ' confirming' : ''}`} role="status">
      {task && (
        <div className="task-head">
          <span className="task-kind">{task.status === 'planning' ? 'PLANNING' : task.steps.length > 1 ? 'TASK' : 'ACTION'}</span>
          <span className="task-text">{task.text}</span>
          {location && <span className="task-loc" title={`Location source: ${location.source}`}>⌖ {location.label}</span>}
        </div>
      )}
      {task?.status === 'planning' && <div className="task-step running"><i>◌</i> Working out the steps…</div>}
      {task?.steps.map((s, i) => (
        <div key={i} className={`task-step ${s.status}`} title={s.error || s.say || ''}>
          <i>{ICON[s.status]}</i> {s.label}
          {s.status === 'failed' && s.error && <em> — {s.error}</em>}
        </div>
      ))}
      {confirm && (
        <div className="task-confirm">
          <span>{confirm.prompt}</span>
          <button className="btn danger" onClick={() => answerConfirmation(true)}>YES</button>
          <button className="btn" onClick={() => answerConfirmation(false)}>NO</button>
        </div>
      )}
    </div>
  );
}
