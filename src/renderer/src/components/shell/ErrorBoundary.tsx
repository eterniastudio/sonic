import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ISSUES_URL } from '@shared/update'

interface State {
  error: Error | null
}

/**
 * Last line of defence for a render error. Without it React unmounts the whole
 * tree, which in a frameless window leaves no title bar and no close button.
 * Kept free of app state and UI primitives so it still renders when those are
 * what broke.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Sonic render error', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const action = 'h-8 rounded-[2px] border border-line-strong px-3 text-[13.5px] text-fg hover:bg-surface-2'
    return (
      <div className="drag-region grid h-full place-items-center bg-bg text-fg">
        <div role="alert" className="no-drag flex max-w-[480px] flex-col gap-3 px-6">
          <h1 className="text-[20px] font-medium">Sonic hit a problem</h1>
          <p className="text-[13px] leading-relaxed text-fg-muted">
            This window stopped drawing. Your library, queue and settings are saved. Reload to continue.
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[2px] border border-line bg-surface-2 p-3 font-mono text-[12px] text-fg-subtle">
            {error.message}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={`${action} border-transparent bg-primary text-primary-fg hover:bg-[var(--sonic-primary-hover)]`}
              onClick={() => window.location.reload()}>
              Reload
            </button>
            <button type="button" className={action}
              onClick={() => void window.sonic?.invoke('app:openDirectory', 'userData').catch(() => undefined)}>
              Open app data folder
            </button>
            <a className={`${action} inline-flex items-center`} href={ISSUES_URL} target="_blank" rel="noreferrer">
              Report a problem
            </a>
            <button type="button" className={action}
              onClick={() => void window.sonic?.invoke('window:close').catch(() => undefined)}>
              Close Sonic
            </button>
          </div>
        </div>
      </div>
    )
  }
}
