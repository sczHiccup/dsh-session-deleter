window.__ModuleLoader__.load({
  id: '@local/session-deleter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Client locale namespace; dictionaries live in `MESSAGES`. */
    const NS = 'session-deleter'
    const COMMAND = 'delete-session'
    const MENU_ICON_KEY = 'session-deleter.delete'
    const MENU_ID = 'session-deleter.delete'

    const MESSAGES = {
      en: {
        'action.delete': 'Delete session',
        'dialog.title': 'Delete this session permanently?',
        'dialog.body':
          'This removes the conversation history, the session log on disk, and the cached projections for this session. It cannot be undone or restored.',
        'dialog.running':
          'This session is running. Deleting it first stops its current turn, its running subagents, its background jobs, and its active reminders.',
        'dialog.target': 'Session',
        'dialog.untitled': 'Untitled session',
        'dialog.acknowledge': 'I understand this deletion is permanent and cannot be undone',
        'dialog.confirm': 'Delete session',
        'dialog.deleting': 'Deleting…',
        'dialog.success.title': 'Session deleted',
        'dialog.notice': 'If the app still shows this session, switch to another session or reload the page.',
        'error.prefix': 'Deletion failed: ',
        'common.cancel': 'Cancel',
        'common.close': 'Close',
      },
      zh: {
        'action.delete': '删除会话',
        'dialog.title': '彻底删除该会话？',
        'dialog.body':
          '这会删除该会话的聊天记录、磁盘上的会话日志以及本地投影缓存，操作不可撤销，也无法恢复。',
        'dialog.running':
          '该会话正在运行。继续删除会先停止它正在进行的回合、正在运行的子代理、后台任务与提醒，然后再删除。',
        'dialog.target': '会话',
        'dialog.untitled': '未命名会话',
        'dialog.acknowledge': '我已知晓此操作不可撤销，并确认删除该会话',
        'dialog.confirm': '删除会话',
        'dialog.deleting': '正在删除…',
        'dialog.success.title': '会话已删除',
        'dialog.notice': '如果界面仍停留在该会话，请切换到其他会话或刷新页面。',
        'error.prefix': '删除失败：',
        'common.cancel': '取消',
        'common.close': '关闭',
      },
    }

    const CSS = `
.sd-header-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto;transition:background-color .12s ease,color .12s ease}
.sd-header-action:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sd-header-action:active{background:var(--dsw-alias-bg-layer-1)}
.sd-header-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sd-header-action svg{width:16px;height:16px;display:block}
.sd-scrim{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto;background:color-mix(in srgb, var(--dsw-alias-bg-base) 68%, transparent)}
.sd-dialog{width:min(460px,100%);max-height:calc(100vh - 48px);overflow:auto;display:flex;flex-direction:column;gap:12px;padding:20px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 24px 64px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)}
.sd-dialog:focus{outline:none}
.sd-dialog-head{display:flex;align-items:center;gap:10px}
.sd-dialog-glyph{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:10px;flex:0 0 auto;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}
.sd-dialog-glyph svg{width:18px;height:18px}
.sd-dialog-title{margin:0;font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.sd-dialog-body{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.sd-target{display:flex;align-items:baseline;gap:8px;padding:8px 10px;border-radius:8px;font-size:13px;background:var(--dsw-alias-bg-layer-2)}
.sd-target-label{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.sd-target-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--dsw-alias-label-primary)}
.sd-warning{display:flex;gap:8px;padding:8px 10px;border-radius:8px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)}
.sd-warning svg{width:15px;height:15px;flex:0 0 auto;margin-top:2px}
.sd-check{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);cursor:pointer}
.sd-check input{margin:2px 0 0;accent-color:var(--dsw-alias-state-error-primary);flex:0 0 auto}
.sd-check input:disabled{cursor:not-allowed}
.sd-error{padding:8px 10px;border-radius:8px;font-size:12.5px;line-height:1.55;white-space:pre-wrap;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}
.sd-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.sd-button{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:7px 14px;font-size:13px;line-height:1.2;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);transition:background-color .12s ease,opacity .12s ease}
.sd-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}
.sd-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sd-button:disabled{opacity:.55;cursor:not-allowed}
.sd-button-danger{border-color:transparent;color:var(--dsw-alias-bg-base);background:var(--dsw-alias-state-error-primary);font-weight:600}
.sd-button-danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 86%, var(--dsw-alias-bg-base))}
.sd-dialog-glyph.is-success{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}
`

    const TrashPaths = [
      h('path', { key: 'lid', d: 'M4 7h16' }),
      h('path', { key: 'handle', d: 'M10 7V5.4A1.4 1.4 0 0 1 11.4 4h1.2A1.4 1.4 0 0 1 14 5.4V7' }),
      h('path', { key: 'body', d: 'M6.2 7l.9 11.3A2.4 2.4 0 0 0 9.5 20h5a2.4 2.4 0 0 0 2.4-1.7L17.8 7' }),
      h('path', { key: 'slot-1', d: 'M10.2 10.6v6' }),
      h('path', { key: 'slot-2', d: 'M13.8 10.6v6' }),
    ]

    function Glyph(props) {
      const size = props.size ?? 16
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: props.strokeWidth ?? 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        TrashPaths,
      )
    }

    function WarningGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' },
        h('path', { key: 'a', d: 'M12 4.5 21 20H3L12 4.5Z' }),
        h('path', { key: 'b', d: 'M12 10v4.2' }),
        h('path', { key: 'c', d: 'M12 17.2h.01' }),
      )
    }

    function CheckGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' },
        h('path', { key: 'tick', d: 'M5 12.5 9.6 17 19 7.5' }),
      )
    }

    // ---------------------------------------------------------------------
    // Locale
    // ---------------------------------------------------------------------

    function translatorFor(active) {
      const dict = /^zh/i.test(String(active ?? '')) ? MESSAGES.zh : MESSAGES.en
      return (key) => dict[key] ?? MESSAGES.en[key] ?? key
    }

    function useTranslate(ctx) {
      const locale = ctx.get('locale')
      const subscribe = React.useCallback(
        (listener) => (typeof locale?.subscribe === 'function' ? locale.subscribe(listener) : () => {}),
        [locale],
      )
      const read = React.useCallback(() => {
        try {
          return locale?.getSnapshot?.().active ?? 'en'
        } catch {
          return 'en'
        }
      }, [locale])
      const active = React.useSyncExternalStore(subscribe, read, read)
      return React.useMemo(() => translatorFor(active), [active])
    }

    // ---------------------------------------------------------------------
    // Tiny snapshot store (the slot `hooks` contract is getSnapshot/subscribe)
    // ---------------------------------------------------------------------

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set(next) {
          value = next
          for (const listener of Array.from(listeners)) listener()
        },
      }
    }

    function useStore(store) {
      const subscribe = React.useCallback(
        (listener) => (typeof store?.subscribe === 'function' ? store.subscribe(listener) : () => {}),
        [store],
      )
      const read = React.useCallback(() => (typeof store?.getSnapshot === 'function' ? store.getSnapshot() : null), [store])
      return React.useSyncExternalStore(subscribe, read, read)
    }

    // ---------------------------------------------------------------------
    // Session row facts (title + running) read from the Sessions service
    // ---------------------------------------------------------------------

    function useSessionRow(ctx, sessionId) {
      const sessions = ctx.get('sessions')
      const list = sessions?.list
      const subscribe = React.useCallback(
        (listener) => (typeof list?.subscribe === 'function' ? list.subscribe(listener) : () => {}),
        [list],
      )
      // Keep the snapshot reference stable even if the store rebuilds rows: a
      // changing getSnapshot result makes useSyncExternalStore re-render forever.
      const cache = React.useRef({ key: '\u0000', row: undefined })
      const read = React.useCallback(() => {
        let row
        try {
          row = list?.getSnapshot?.()?.byId?.[sessionId]
        } catch {
          row = undefined
        }
        const key = `${row?.displayTitle ?? ''}\u0001${row?.title ?? ''}\u0001${row?.running === true ? '1' : '0'}`
        if (cache.current.key !== key) cache.current = { key, row }
        return cache.current.row
      }, [list, sessionId])
      return React.useSyncExternalStore(subscribe, read, read)
    }

    function sessionTitle(row, request, t) {
      const title = row?.displayTitle ?? row?.title ?? request?.displayTitle
      const trimmed = typeof title === 'string' ? title.trim() : ''
      return trimmed.length > 0 ? trimmed : t('dialog.untitled')
    }

    // ---------------------------------------------------------------------
    // Header action
    // ---------------------------------------------------------------------

    function HeaderDeleteButton(props) {
      const ctx = props.__ctx
      const t = useTranslate(ctx)
      const label = t('action.delete')
      return h(
        React.Fragment,
        null,
        h('style', { key: 'sd-style' }, CSS),
        h(
          'button',
          {
            key: 'sd-button',
            type: 'button',
            className: 'sd-header-action',
            title: label,
            'aria-label': label,
            onClick: () => props.requestDelete?.({ sessionId: props.sessionId, current: true }),
          },
          h(Glyph, null),
        ),
      )
    }

    function ContextMenuDeleteIcon() {
      return h(Glyph, { strokeWidth: 1.6 })
    }

    // ---------------------------------------------------------------------
    // Confirmation dialog (frame-wide overlay entry)
    // ---------------------------------------------------------------------

    function DeleteSessionDialog(props) {
      const ctx = props.__ctx
      const t = useTranslate(ctx)
      const request = useStore(props.deleteRequest)
      const row = useSessionRow(ctx, request?.sessionId)
      const [checked, setChecked] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [done, setDone] = React.useState(null)
      const cancelRef = React.useRef(null)
      const dialogRef = React.useRef(null)
      const settleRef = React.useRef(props.settleDelete)
      settleRef.current = props.settleDelete

      // A new request always starts from a clean, unchecked dialog.
      React.useEffect(() => {
        setChecked(false)
        setError(null)
        setDone(null)
        setBusy(false)
      }, [request])

      const open = request !== null
      React.useEffect(() => {
        if (!open) return undefined
        const previous = typeof document !== 'undefined' ? document.activeElement : null
        const focusTarget = cancelRef.current ?? dialogRef.current
        focusTarget?.focus?.()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') settleRef.current?.()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          previous?.focus?.()
        }
      }, [open])

      if (!open) return null

      const title = sessionTitle(row, request, t)
      const running = row?.running === true
      const success = done !== null

      const close = () => {
        if (busy) return
        props.settleDelete()
      }

      const confirm = async () => {
        if (busy || !checked || success) return
        setBusy(true)
        setError(null)
        try {
          const commands = ctx.remote?.commands
          if (typeof commands?.execute !== 'function') {
            setError(`${t('error.prefix')}the Host command channel is unavailable`)
            return
          }
          const result = await commands.execute(request.sessionId, `/${COMMAND} ${request.sessionId}`, [])
          if (!result || result.ok !== true) {
            setError(`${t('error.prefix')}${result?.error?.message ?? result?.error?.code ?? 'command failed'}`)
            return
          }
          const execution = result.value
          if (execution === undefined) {
            setError(`${t('error.prefix')}${`unknown command: ${COMMAND}`}`)
            return
          }
          if (execution.result.kind === 'error') {
            setError(`${t('error.prefix')}${execution.result.text}`)
            return
          }
          setDone(execution.result.text ?? t('dialog.success.title'))
          leaveDeletedSession(ctx, request.sessionId)
        } catch (thrown) {
          setError(`${t('error.prefix')}${thrown instanceof Error ? thrown.message : String(thrown)}`)
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        {
          className: 'sd-scrim',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close()
          },
        },
        h('style', null, CSS),
        h(
          'div',
          {
            className: 'sd-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'sd-dialog-title',
            'aria-describedby': success ? 'sd-dialog-notice' : 'sd-dialog-body',
            tabIndex: -1,
            ref: dialogRef,
          },
          h(
            'div',
            { className: 'sd-dialog-head' },
            h('span', { className: `sd-dialog-glyph${success ? ' is-success' : ''}` }, success ? h(CheckGlyph, null) : h(Glyph, null)),
            h('h2', { className: 'sd-dialog-title', id: 'sd-dialog-title' }, success ? t('dialog.success.title') : t('dialog.title')),
          ),
          success
            ? h(
                React.Fragment,
                null,
                h('p', { className: 'sd-dialog-body', id: 'sd-dialog-notice' }, done),
                h('p', { className: 'sd-dialog-body' }, t('dialog.notice')),
                h(
                  'div',
                  { className: 'sd-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'sd-button', onClick: close, autoFocus: true },
                    t('common.close'),
                  ),
                ),
              )
            : h(
                React.Fragment,
                null,
                h('p', { className: 'sd-dialog-body', id: 'sd-dialog-body' }, t('dialog.body')),
                running
                  ? h(
                      'div',
                      { className: 'sd-warning', role: 'status' },
                      h(WarningGlyph, null),
                      h('span', null, t('dialog.running')),
                    )
                  : null,
                h(
                  'div',
                  { className: 'sd-target' },
                  h('span', { className: 'sd-target-label' }, `${t('dialog.target')}:`),
                  h('span', { className: 'sd-target-name', title }, title),
                ),
                h(
                  'label',
                  { className: 'sd-check' },
                  h('input', {
                    type: 'checkbox',
                    checked,
                    disabled: busy,
                    onChange: (event) => setChecked(event.target.checked === true),
                  }),
                  h('span', null, t('dialog.acknowledge')),
                ),
                error !== null ? h('div', { className: 'sd-error', role: 'alert' }, error) : null,
                h(
                  'div',
                  { className: 'sd-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'sd-button', onClick: close, disabled: busy, ref: cancelRef },
                    t('common.cancel'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sd-button sd-button-danger',
                      onClick: confirm,
                      disabled: busy || !checked,
                    },
                    busy ? t('dialog.deleting') : t('dialog.confirm'),
                  ),
                ),
              ),
        ),
      )
    }

    /**
     * A deleted session must not stay on screen. `sessions.binding` exists only
     * while this page still holds the session, so a surviving binding means the
     * main panel is showing it; a fresh New Session moves the panel away.
     */
    function leaveDeletedSession(ctx, sessionId) {
      try {
        const sessions = ctx.get('sessions')
        if (typeof sessions?.binding !== 'function' || sessions.binding(sessionId) === undefined) return
        const uiWorkspace = ctx.get('uiWorkspace')
        uiWorkspace?.startSession?.()
      } catch (error) {
        console.warn('session-deleter: could not leave the deleted session', error)
      }
    }

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------

    return {
      // `remote` is the parent Service that owns the mounted namespace: reading
      // ctx.remote.commands touches both, so both must be injected.
      inject: ['slots', 'remote', 'remote.commands', 'contextMenus', 'sessions'],
      apply(ctx) {
        const deleteRequest = createStore(null)
        const requestDelete = (request) => {
          if (typeof request?.sessionId !== 'string' || request.sessionId.length === 0) return
          deleteRequest.set({ ...request, nonce: Date.now() })
        }
        const settleDelete = () => deleteRequest.set(null)

        // Read lazily: the locale service may be provided after this plugin applies.
        const activeLocale = () => {
          try {
            return ctx.get('locale')?.getSnapshot?.().active
          } catch {
            return undefined
          }
        }

        ctx.effect(() => {
          const locale = ctx.get('locale')
          if (typeof locale?.register !== 'function') return () => {}
          const disposers = []
          for (const id of ['en', 'zh']) {
            try {
              disposers.push(locale.register(NS, id, MESSAGES[id]))
            } catch (error) {
              console.warn('session-deleter: locale registration failed', error)
            }
          }
          return () => {
            for (const dispose of disposers) dispose?.()
          }
        }, 'session-deleter: locale dictionaries')

        // Conversation-header trash button.
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'session-deleter.delete',
              order: 20,
              inject: () => ({ __ctx: ctx, requestDelete }),
            },
            HeaderDeleteButton,
          ),
        )

        // Sidebar row "..." menu: the built-in Session context menu.
        ctx.slots.inject('contextMenu.icon', function* () {
          yield ctx.slots.register({ name: 'contextMenu.icon', key: MENU_ICON_KEY }, ContextMenuDeleteIcon)
        })

        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: MENU_ID,
              target: 'session',
              order: 800,
              resolve: ({ sessionId, displayTitle }) => {
                if (typeof sessionId !== 'string' || sessionId.length === 0) return []
                return [
                  {
                    id: 'delete-session',
                    label: translatorFor(activeLocale())('action.delete'),
                    icon: { key: MENU_ICON_KEY },
                    danger: true,
                    separatorBefore: true,
                    run: () => requestDelete({ sessionId, displayTitle, current: false }),
                  },
                ]
              },
            }),
          'session-deleter: session menu action',
        )

        // One frame-wide confirmation surface for both entry points.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'session-deleter.confirm',
              order: 900,
              inject: () => ({ __ctx: ctx, deleteRequest, settleDelete }),
            },
            DeleteSessionDialog,
          ),
        )
      },
    }
  },
})
