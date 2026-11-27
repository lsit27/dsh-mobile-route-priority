/**
 * dsh-mobile-route-priority client half.
 *
 * UI contract:
 *   - Primary entry: an injected item in the fnOS "飞牛 OS" footer menu
 *     (`.dsh-fnos-footer-menu`), cloned from the last existing menu item so it
 *     keeps that menu's icon/structure and visual language. dsh-fnos renders
 *     this menu from a hard-coded list and exposes no slot, so a
 *     MutationObserver watches for the menu opening and appends one clone —
 *     the same approach dsh-restart uses for its restart entry.
 *   - Secondary entry: a `sidebar.panellist` icon registering the same
 *     `main` panel, so the page is also reachable from the plugin row when the
 *     sidebar shows it.
 *   - The panel itself is the existing Host page at `/dsh-mobile-route/panel`,
 *     opened in a new tab. No other plugin's DOM or stylesheet is read for
 *     layout; the clone is the only cross-plugin DOM touch, and it is limited
 *     to the fnOS menu this feature deliberately extends.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile-route-priority',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'mobile-route'
    // Primary route family: a top-level prefix the fnOS gateway auto-discovers
    // and proxies. `/api/*` is reserved by that gateway, so the panel must not
    // live there for gateway access to work.
    const PANEL_PATH = '/dsh-mobile-route/panel'
    const PANEL_TITLE = '手机连接选路'
    const MENU_ITEM_FLAG = 'data-dsh-mobile-route-injected'

    /**
     * Resolve the panel URL against the document base, so it works both in a
     * plain `dsh web` page (no `<base>`) and behind the fnOS gateway, which
     * injects `<base href="/app/<name>/">` and proxies that prefix to dsh.
     */
    function panelUrl() {
      try {
        const base = document.querySelector('base')?.href
        if (base !== undefined && base !== '') {
          return new URL(PANEL_PATH.replace(/^\//, ''), base).toString()
        }
      } catch {
        // fall through to the root-relative path
      }
      return PANEL_PATH
    }

    function openPanel() {
      const url = panelUrl()
      const opened = window.open(url, '_blank', 'noopener')
      if (opened === null) window.location.assign(url)
    }

    /** Route icon for the sidebar panel row (secondary entry). */
    function MobileRouteIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20
      const active = props.active === true
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M4 17.5c0-2 1.6-2.4 3.2-2.8 1.8-.5 3.2-1 3.2-3.2 0-2.2-1.4-2.7-3.2-3.2C5.6 7.9 4 7.5 4 5.5',
          stroke: 'currentColor', strokeWidth: active ? 2.2 : 1.8, strokeLinecap: 'round', opacity: active ? 1 : 0.75,
        }),
        h('circle', { cx: 4, cy: 5.5, r: 2, fill: 'currentColor', opacity: active ? 1 : 0.75 }),
        h('circle', { cx: 4, cy: 17.5, r: 2, fill: 'currentColor', opacity: active ? 1 : 0.75 }),
        h('circle', { cx: 19.5, cy: 11.5, r: 2.2, fill: 'currentColor', opacity: active ? 1 : 0.75 }),
        h('path', {
          d: 'M6 5.5h8.2a3 3 0 0 1 3 3v.8M6 17.5h8.2a3 3 0 0 0 3-3v-.8',
          stroke: 'currentColor', strokeWidth: active ? 2 : 1.6, strokeLinecap: 'round', opacity: active ? 1 : 0.6,
        }),
      )
    }

    /** The main panel: the Host-registered configuration UI, framed. */
    function MobileRoutePanel() {
      return h('iframe', {
        src: PANEL_PATH,
        title: PANEL_TITLE,
        style: { display: 'block', flex: '1 1 auto', width: '100%', height: '100%', minHeight: 0, border: 'none', background: 'transparent' },
      })
    }

    /**
     * Append one menu item to the fnOS footer menu, cloned from the last
     * existing item so icon and structure match. Idempotent: a flag attribute
     * marks the clone, and the observer re-injects after any re-render.
     */
    function injectFnosMenuItem() {
      if (typeof document === 'undefined') return
      const menu = document.querySelector('.dsh-fnos-footer-menu')
      if (menu === null) return
      if (menu.querySelector('[' + MENU_ITEM_FLAG + ']') !== null) return
      const items = menu.querySelectorAll('[role="menuitem"]')
      if (items.length === 0) return
      const source = items[items.length - 1]
      const clone = source.cloneNode(true)
      if (clone === null || typeof clone !== 'object') return
      const isElement = typeof HTMLElement !== 'undefined' && clone instanceof HTMLElement
      if (!isElement && typeof clone.setAttribute !== 'function') return

      // Replace only the visible text, preserving the cloned icon and markup.
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT)
      let textNode = null
      while (walker.nextNode()) {
        const node = walker.currentNode
        if (node.nodeValue !== null && node.nodeValue.trim() !== '') textNode = node
      }
      if (textNode !== null) textNode.nodeValue = PANEL_TITLE

      clone.setAttribute(MENU_ITEM_FLAG, '')
      clone.removeAttribute('disabled')
      clone.removeAttribute('aria-disabled')
      clone.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        openPanel()
        // Close the menu the same way a native item would.
        if (typeof menu.blur === 'function') menu.blur()
      })
      menu.appendChild(clone)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Secondary entry: sidebar panel row + the main panel it opens.
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, MobileRoutePanel),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => PANEL_TITLE }, MobileRouteIcon),
        )

        // Primary entry: the fnOS "飞牛 OS" footer menu item.
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          if (typeof MutationObserver === 'undefined') return () => {}
          const observer = new MutationObserver(() => injectFnosMenuItem())
          observer.observe(document.body, { childList: true, subtree: true })
          injectFnosMenuItem()
          return () => {
            try { observer.disconnect() } catch { /* ignore */ }
            const existing = document.querySelector('[' + MENU_ITEM_FLAG + ']')
            if (existing !== null) existing.remove()
          }
        }, 'dsh-mobile-route-priority: fnos menu entry')
      },
    }
  },
})
