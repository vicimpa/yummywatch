import { exit, onBackButtonPress } from '@tauri-apps/api/app';
import {
  browserFullscreenElement,
  desktopFullscreen,
  desktopFullscreenChanging,
  exitBrowserFullscreen,
  exitDesktopFullscreen,
  isDesktop,
} from './desktop';
import { focusTarget, keyboardTargets } from './keyboard-navigation';
import { navigation } from './navigation';
import { notify } from './notifications';
import { pageScrollKey } from './page-scroll';
import { isTvMode } from './tv-mode';

const arrows = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const panelSelector = '[data-sidebar-open=true],.video-settings,.app-update-popover';
const skipped = '[data-tv-skip],.overlay-scrollbar-thumb';
const playerSelector = '[data-tv-player]';
const tabsSelector = '[data-tv-tabs],.episode-voice-tabs';
const unavailable = '[hidden],[inert],[aria-hidden=true]';
const textEditor =
  'textarea,[contenteditable]:not([contenteditable=false]),[role=textbox],input:not([type=range],[type=checkbox],[type=radio],[type=button],[type=submit])';
const pointerBlur =
  'a[href],button,summary,input[type=range],input[type=checkbox],input[type=radio],[role=button]';
const activation =
  'a[href],button,summary,input[type=checkbox],input[type=radio],input[type=button],input[type=submit],[role=button]';

function bounds(node: HTMLElement) {
  return (
    node.matches('[data-gallery-link]') ? node.closest('[data-gallery-item]') || node : node
  ).getBoundingClientRect();
}

function shelfNeighbor(active: HTMLElement, targets: HTMLElement[], direction: number) {
  const shelf = active.closest('.gallery-shelf');
  const list = shelf?.querySelector('.gallery-rail');
  const actions = shelf?.querySelector('.gallery-shelf-actions');
  const enteringList = direction > 0 && actions?.contains(active);
  const destination = enteringList
    ? list
    : direction < 0 && list?.contains(active)
      ? actions
      : null;
  if (!destination) return;

  const source = bounds(active);
  const viewport = destination.getBoundingClientRect();
  let nearest: HTMLElement | undefined;
  let best = Infinity;
  for (const node of targets) {
    if (!destination.contains(node) || (enteringList && !node.matches('[data-gallery-link]')))
      continue;
    const box = bounds(node);
    const overlap = Math.min(box.right, viewport.right) - Math.max(box.left, viewport.left);
    if (enteringList && overlap <= 0) continue;
    const cropped = enteringList && overlap < box.width - 1;
    const score =
      Math.abs((box.left + box.right - source.left - source.right) / 2) +
      (cropped ? viewport.width : 0);
    if (score < best) {
      nearest = node;
      best = score;
    }
  }
  return nearest;
}

function nextInDirection(active: HTMLElement, targets: HTMLElement[], key: string) {
  const current = bounds(active);
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  const tabs = active.closest(tabsSelector);
  if (horizontal && tabs) {
    const links = targets.filter(node => tabs.contains(node));
    return links[links.indexOf(active) + direction];
  }
  if (!horizontal) {
    const neighbor = shelfNeighbor(active, targets, direction);
    if (neighbor) return neighbor;
  }
  const vertical = !horizontal && active.closest('[data-tv-vertical]');
  if (vertical) {
    const controls = targets.filter(node => vertical.contains(node));
    return controls[controls.indexOf(active) + direction];
  }
  const profile = !horizontal && active.closest('.profile-page');
  const column = profile && active.closest('[data-tv-profile-column]');
  const galleryRow =
    horizontal && active.matches('[data-gallery-link]') ? active.closest('.gallery-rail') : null;
  let nearest: HTMLElement | undefined;
  let best = Infinity;

  for (const node of targets) {
    if (node === active || (galleryRow && !galleryRow.contains(node))) continue;
    if (column) {
      const destinationColumn = node.closest('[data-tv-profile-column]');
      if (destinationColumn && destinationColumn !== column) continue;
    }
    const destinationTabs = !horizontal && node.closest<HTMLElement>(tabsSelector);
    if (destinationTabs && destinationTabs === tabs) continue;
    const box = bounds(node);
    const dx = (box.left + box.right - current.left - current.right) / 2;
    const dy = (box.top + box.bottom - current.top - current.bottom) / 2;
    const forward = (horizontal ? dx : dy) * direction;
    const minimum = horizontal ? 2 : Math.max(2, Math.min(current.height, box.height) / 2);
    if (forward <= minimum) continue;

    const gap = horizontal
      ? Math.max(0, box.top - current.bottom, current.top - box.bottom)
      : Math.max(0, box.left - current.right, current.left - box.right);
    // Horizontal moves from the page should stay in their row. Inside a panel,
    // the nearest control can be slightly above or below (e.g. a close button).
    if (horizontal && gap > 12 && active.closest('#main') && !active.closest(panelSelector))
      continue;
    // A full-width field leads into the first item in the next row.
    const spanningRow = !horizontal && gap === 0 && current.width >= box.width * 1.75;
    const cross = Math.abs(horizontal ? dy : spanningRow ? box.left - current.left : dx);
    const score =
      forward + (profile ? Math.min(18, gap * 0.25 + cross * 0.08) : gap * 5 + cross * 0.65);
    if (score < best) {
      best = score;
      nearest = node;
    }
  }
  const destinationTabs = !horizontal && nearest?.closest(tabsSelector);
  return (
    (destinationTabs &&
      targets.find(
        node =>
          destinationTabs.contains(node) && node.matches('[aria-current=page],[aria-pressed=true]')
      )) ||
    nearest
  );
}

function scrollInDirection(
  root: HTMLElement,
  active: HTMLElement,
  direction: number,
  returning = false
) {
  for (
    let parent: HTMLElement | null = root.contains(active) ? active : root;
    parent && root.contains(parent);
    parent = parent.parentElement
  ) {
    if (!/auto|scroll/.test(getComputedStyle(parent).overflowY)) continue;
    const limit = parent.scrollHeight - parent.clientHeight;
    if (limit <= 1) continue;
    if (returning) {
      const anchor = active.getBoundingClientRect();
      const viewport = parent.getBoundingClientRect();
      if (direction < 0 ? anchor.bottom >= viewport.top : anchor.top <= viewport.bottom) continue;
    }
    const step = Math.max(1, Math.floor(parent.clientHeight * 0.75));
    const position = Math.max(0, Math.min(limit, parent.scrollTop + direction * step));
    if (Math.abs(position - parent.scrollTop) < 1) continue;
    parent.scrollTop = position;
    return true;
  }
  return false;
}

type FocusRecord = { node: HTMLElement; id: string; href?: string };
const snapshot = (node: HTMLElement): FocusRecord => ({
  node,
  id: node.id,
  href: node.dataset.appHref,
});

export function installDirectionalNavigation(goBack: () => void, keyboardInteraction: () => void) {
  const tv = isTvMode();
  const dataset = document.documentElement.dataset;
  const usingKeyboard = () => dataset.inputMode === 'keyboard';
  const pages = new Map<string, FocusRecord>();
  const panelFocus = new WeakMap<HTMLElement, HTMLElement>();
  let page = '';
  let previousScope: HTMLElement | null = null;
  let restorePage = true;
  let frame = 0;
  let stopped = false;
  let unlisten: (() => Promise<void>) | undefined;
  let centerDown = false;
  let centerCard: HTMLElement | null = null;
  let centerTimer = 0;
  let editor: HTMLInputElement | HTMLTextAreaElement | null = null;
  let range: HTMLInputElement | null = null;

  const main = () => document.getElementById('main');
  const mainControl = (selector: string) =>
    Array.from(main()?.querySelectorAll<HTMLElement>(selector) || []).find(
      node => !node.closest(unavailable)
    );
  const rail = () => {
    const menu = document.querySelector<HTMLElement>('.media-nav:not(.is-away)');
    return menu?.getClientRects().length ? menu : null;
  };
  const railEntry = () => {
    const menu = rail();
    if (!menu) return;
    const links = keyboardTargets(menu);
    return links.find(link => link.matches('[aria-current=page],.active')) || links[0];
  };
  const overlay = () =>
    [...document.querySelectorAll<HTMLElement>('dialog[open]')].at(-1) ||
    document.querySelector<HTMLElement>('[data-card-context-menu]') ||
    [...document.querySelectorAll<HTMLElement>(panelSelector)].at(-1);
  const scope = () =>
    overlay() ||
    mainControl('.playback-loader.is-error,[data-tv-countdown]') ||
    mainControl(playerSelector) ||
    main();
  const targetsIn = (root: ParentNode) =>
    keyboardTargets(root).filter(node => !node.matches(skipped));
  const inScope = (root: HTMLElement, node: HTMLElement) =>
    root.contains(node) || (root === main() && !!rail()?.contains(node));
  const valid = (root: HTMLElement, node: HTMLElement) =>
    inScope(root, node) &&
    !node.closest(unavailable) &&
    !node.matches(skipped) &&
    !node.matches(':disabled') &&
    node.tabIndex >= 0 &&
    !!node.getClientRects().length;
  const remembered = (targets: HTMLElement[]) => {
    const record = pages.get(page);
    if (!record) return;
    return targets.includes(record.node)
      ? record.node
      : targets.find(
          node =>
            (record.id && node.id === record.id) ||
            (record.href && node.dataset.appHref === record.href)
        );
  };
  const entry = (root: HTMLElement, targets: HTMLElement[]) => {
    if (root.matches(playerSelector))
      return (
        (root.dataset.tvControlsOpen === 'true' &&
          targets.find(node => node.closest('.video-toolbar'))) ||
        root
      );
    return (
      targets.find(node => node.matches('[data-nav-primary]')) ||
      targets.find(node =>
        node.matches(
          '[aria-current=true],[aria-current=page],[aria-selected=true],.source-option.selected,.episode-card[aria-pressed=true]'
        )
      ) ||
      targets.find(node => node.matches('[data-gallery-link]')) ||
      targets.find(node => !node.matches('[data-tv-close]')) ||
      targets[0]
    );
  };
  const imeOpen = () => {
    const { tvIme, keyboard } = document.documentElement.dataset;
    return tvIme === undefined ? keyboard === 'open' : tvIme === 'true';
  };
  const endEdit = () => {
    if (editor) editor.readOnly = true;
    editor = null;
  };
  const startEdit = (field: HTMLInputElement | HTMLTextAreaElement) => {
    // Reconnect the Android input method now that the focused field is writable.
    if (document.activeElement === field) field.blur();
    endEdit();
    field.readOnly = false;
    editor = field;
    focusTarget(field);
  };
  const endAdjustment = () => {
    range?.removeAttribute('data-tv-adjusting');
    range = null;
  };
  const toggleAdjustment = (input: HTMLInputElement) => {
    const wasAdjusting = range === input;
    endAdjustment();
    if (!wasAdjusting) {
      range = input;
      input.setAttribute('data-tv-adjusting', '');
    }
  };
  const changeRange = (input: HTMLInputElement, direction: number) => {
    const previous = input.value;
    if (input.step === 'any') {
      const from = Number(input.min || 0);
      const to = Number(input.max || 100);
      input.valueAsNumber = Math.min(to, Math.max(from, input.valueAsNumber + direction));
    } else if (direction > 0) input.stepUp();
    else input.stepDown();
    if (input.value !== previous) input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const reconcile = () => {
    const root = scope();
    if (!root || !page || !usingKeyboard()) return;
    const active = document.activeElement as HTMLElement;
    const same = previousScope === root;
    const changed = !same || restorePage;
    if (!changed && valid(root, active)) return;

    const targets = targetsIn(root);
    const inContent = targets.includes(active);
    previousScope = root;
    if (root === main() && !targets.length) {
      if (!rail()?.contains(active)) railEntry()?.focus({ preventScroll: true });
      return;
    }
    const pageTarget = root === main() && remembered(targets);
    if (root === main() && restorePage && pages.has(page) && !pageTarget) {
      // Keep the saved target while the catalog restores scroll and mounts its virtual rows.
      if (!valid(root, active)) {
        const fallback = entry(root, targets) || railEntry();
        if (fallback) focusTarget(fallback, true);
      }
      return;
    }
    const last = !restorePage && panelFocus.get(root);
    if (root === main() || root.matches(playerSelector)) restorePage = false;
    const target =
      (last && valid(root, last) && last) ||
      (root === main() && changed && pageTarget) ||
      (!changed && inContent && active) ||
      entry(root, targets) ||
      (root === main() && railEntry());
    if (target && target !== active) focusTarget(target, true);
  };

  const schedule = () => {
    if (stopped || frame || !usingKeyboard()) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      reconcile();
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'open', 'inert', 'aria-hidden', 'disabled', 'data-sidebar-open'],
  });

  const rememberFocus = (active: HTMLElement) => {
    if (!usingKeyboard()) return;
    const root = scope();
    if (!root) return;
    if (!valid(root, active)) {
      schedule();
      return;
    }
    if (root === main()) {
      if (!restorePage && page) {
        panelFocus.set(root, active);
        if (root.contains(active)) {
          pages.set(page, snapshot(active));
          if (pages.size > 50) pages.delete(pages.keys().next().value!);
        }
      }
    } else panelFocus.set(root, active);
  };
  const record = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement) rememberFocus(event.target);
  };
  const blurControl = (event: FocusEvent) => {
    if (event.target === editor) endEdit();
    if (event.target === range) endAdjustment();
  };
  const clickControl = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    const field = event.target;
    if (
      (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
      field.hasAttribute('data-tv-editor') &&
      field.readOnly &&
      !field.disabled
    )
      startEdit(field);
  };

  const back = (hardware: boolean) => {
    resetCenter();
    const active = document.activeElement as HTMLElement;
    const root = overlay();
    const dropdown = (root || main())?.querySelector<HTMLElement>(
      '[role=combobox][aria-expanded=true]'
    );
    if (dropdown) {
      dropdown.click();
      return;
    }
    if (range === active) {
      endAdjustment();
      return;
    }
    if (editor === active) {
      endEdit();
      if (!hardware) {
        active.blur();
        focusTarget(active);
        return;
      }
    }
    const countdown =
      active.closest('[data-tv-countdown]') ||
      (root ? root.querySelector('[data-tv-countdown]') : mainControl('[data-tv-countdown]'));
    if (countdown) {
      countdown.querySelector<HTMLElement>('[data-tv-close]')?.click();
      return;
    }
    if (root) {
      if (root.matches('[data-card-context-menu]'))
        root.dispatchEvent(new Event('yumiwatch:tv-dismiss'));
      else if (root.matches('.app-update-popover'))
        root.parentElement?.querySelector<HTMLElement>('.app-update-trigger')?.click();
      else root.querySelector<HTMLElement>('[data-tv-close]')?.click();
      schedule();
      return;
    }
    if (desktopFullscreenChanging()) return;
    const browserFullscreen = browserFullscreenElement();
    if (browserFullscreen || desktopFullscreen()) {
      const exitFullscreen = browserFullscreen ? exitBrowserFullscreen : exitDesktopFullscreen;
      void exitFullscreen().catch(() => notify('Не удалось выйти из полного экрана.'));
      return;
    }
    if (!tv || navigation.value.canBack || (location.hash && location.hash !== '#/')) goBack();
    else if (hardware && isDesktop()) void exit(0).catch(() => {});
  };

  const cancelCard = () => {
    clearTimeout(centerTimer);
    centerCard = null;
  };
  const openCardMenu = () => {
    const card = centerCard;
    cancelCard();
    if (card?.isConnected && card === document.activeElement)
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  };
  const resetCenter = () => {
    centerDown = false;
    cancelCard();
  };
  const imeClosed = () => {
    endEdit();
    resetCenter();
  };
  const capture = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const arrow = arrows.includes(event.key);
    const backKey =
      event.key === 'Escape' ||
      event.key === 'BrowserBack' ||
      (event.key === 'Backspace' && !target?.closest(textEditor));
    const wasKeyboard = usingKeyboard();
    if (
      arrow ||
      backKey ||
      ['Tab', 'Enter', ' ', 'Home', 'End', 'PageUp', 'PageDown', 'ContextMenu'].includes(
        event.key
      ) ||
      (event.key.length === 1 && !target?.closest(textEditor)) ||
      event.code === 'Slash'
    )
      dataset.inputMode = 'keyboard';
    keyboardInteraction();

    if (backKey) {
      if (dataset.middleScroll) return;
      const dialog = overlay();
      if (
        event.key === 'Escape' &&
        dialog?.matches('dialog') &&
        !dialog.querySelector('[data-tv-close]')
      )
        return;
      if (
        !tv &&
        !dialog &&
        target?.closest(textEditor) &&
        !browserFullscreenElement() &&
        !desktopFullscreen()
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) back(false);
      return;
    }
    if (restorePage && (arrow || ['Tab', 'Enter', 'Home', 'End'].includes(event.key))) {
      const root = scope();
      const active = document.activeElement as HTMLElement;
      if (!arrow && wasKeyboard && (!root || !valid(root, active))) reconcile();
      if (root && valid(root, active)) {
        previousScope = root;
        restorePage = false;
        rememberFocus(active);
      }
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      const root = scope();
      if (!root) return;
      const menu = root === main() ? rail() : null;
      const app = !tv && root === main() && document.getElementById('app');
      const targets = app
        ? targetsIn(app)
        : [...(menu ? keyboardTargets(menu) : []), ...targetsIn(root)];
      if (root.matches(playerSelector)) targets.unshift(root);
      if (!targets.length) return;
      const index = targets.indexOf(document.activeElement as HTMLElement);
      const next =
        index < 0
          ? event.shiftKey
            ? targets.length - 1
            : 0
          : (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
      focusTarget(targets[next], true);
      return;
    }
    if (!arrow && event.key !== 'Enter') return;
    if (arrow) {
      cancelCard();
      if (editor && !imeOpen()) endEdit();
      if (range) {
        if (range === document.activeElement && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          changeRange(range, event.key === 'ArrowRight' ? 1 : -1);
        } else endAdjustment();
      }
      return;
    }
    if (!tv && target?.closest(`${textEditor},select`)) return;
    // WebView 91 can report a repeated Android center press with repeat=false.
    if (centerDown || event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      if (centerCard) openCardMenu();
      return;
    }
    centerDown = true;
    const active = document.activeElement as HTMLElement;
    const root = scope();
    if (!root || !valid(root, active)) {
      if (root?.matches(playerSelector) && (target === document.body || target === main())) {
        root.focus({ preventScroll: true });
        return;
      }
      event.preventDefault();
      reconcile();
      return;
    }
    if (
      root.contains(active) &&
      (scrollInDirection(root, active, -1, true) || scrollInDirection(root, active, 1, true))
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (active.matches('[role=combobox],select') || active.matches(playerSelector)) return;
    if (active instanceof HTMLInputElement && active.type === 'range') {
      event.preventDefault();
      event.stopPropagation();
      if (!active.hasAttribute('data-tv-timeline')) toggleAdjustment(active);
      return;
    }
    if (
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
      active.hasAttribute('data-tv-editor')
    ) {
      if (editor === active && imeOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      startEdit(active);
      return;
    }
    if (!active.matches(activation)) {
      event.preventDefault();
      return;
    }
    if (!tv && !active.matches('[data-gallery-link]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (active.matches('[data-gallery-link]') && active.closest('[data-gallery-item]')) {
      centerCard = active;
      centerTimer = window.setTimeout(openCardMenu, 550);
    } else active.click();
  };

  const release = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    const target = centerCard;
    resetCenter();
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    if (target.isConnected && target === document.activeElement) target.click();
  };

  const move = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;

    const target = event.target instanceof HTMLElement ? event.target : null;
    if (event.key === '/' || event.code === 'Slash') {
      if (target?.closest(`${textEditor},select`)) return;
      event.preventDefault();
      location.hash = '/search';
      return;
    }
    if (!arrows.includes(event.key)) return;

    const active = document.activeElement as HTMLElement;
    if (active === editor && imeOpen()) return;
    const vertical = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (
      !tv &&
      (target?.closest('textarea,[contenteditable]:not([contenteditable=false]),[role=textbox]') ||
        (!vertical && target?.closest(`${textEditor},select`)))
    )
      return;
    const root = scope();
    if (!root) return;
    if (
      !vertical &&
      root.matches(playerSelector) &&
      (target === document.body || target === main())
    )
      return;
    event.preventDefault();
    const targets = targetsIn(root);
    const menu = root === main() ? rail() : null;
    if (menu?.contains(active)) {
      if (event.key === 'ArrowRight') {
        const target = remembered(targets) || entry(root, targets);
        if (target) focusTarget(target, true);
        else if (root.scrollHeight > root.clientHeight) root.focus({ preventScroll: true });
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const links = keyboardTargets(menu);
        const next = links[links.indexOf(active) + (event.key === 'ArrowUp' ? -1 : 1)];
        if (next) focusTarget(next, true);
      }
      return;
    }
    if (!targets.includes(active)) {
      if (vertical && !targets.length && scrollInDirection(root, active, vertical)) return;
      reconcile();
      return;
    }
    if (vertical && scrollInDirection(root, active, vertical, true)) return;
    const next =
      nextInDirection(active, targets, event.key) ||
      (menu && event.key === 'ArrowLeft' && railEntry());
    if (next) focusTarget(next, true);
    else if (vertical) scrollInDirection(root, active, vertical);
    else if (
      !menu &&
      root === main() &&
      event.key === 'ArrowLeft' &&
      active.closest('[data-gallery-item]')
    )
      window.dispatchEvent(new Event('yumiwatch:menu'));
  };

  window.addEventListener('keydown', capture, true);
  window.addEventListener('keyup', release, true);
  window.addEventListener('keydown', move);
  window.addEventListener('blur', resetCenter);
  window.addEventListener('yumiwatch:tv-ime-hidden', imeClosed);
  document.addEventListener('click', clickControl, true);
  document.addEventListener('focusin', record);
  document.addEventListener('focusout', blurControl);
  if (tv && isDesktop())
    void onBackButtonPress(() => back(true))
      .then(listener => {
        if (stopped) void listener.unregister().catch(() => {});
        else unlisten = () => listener.unregister();
      })
      .catch(() => {});

  return {
    suspend() {
      resetCenter();
      endAdjustment();
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active.matches(`${pointerBlur},${playerSelector}`) &&
        !active.matches('[role=combobox][aria-expanded=true]')
      )
        active.blur();
    },
    navigate(path: string) {
      const key = pageScrollKey(path);
      if (key === page) return;
      page = key;
      restorePage = true;
      const root = main();
      if (root) panelFocus.delete(root);
      cancelCard();
      endEdit();
      endAdjustment();
      schedule();
    },
    dispose() {
      stopped = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      resetCenter();
      endEdit();
      endAdjustment();
      window.removeEventListener('keydown', capture, true);
      window.removeEventListener('keyup', release, true);
      window.removeEventListener('keydown', move);
      window.removeEventListener('blur', resetCenter);
      window.removeEventListener('yumiwatch:tv-ime-hidden', imeClosed);
      document.removeEventListener('click', clickControl, true);
      document.removeEventListener('focusin', record);
      document.removeEventListener('focusout', blurControl);
      void unlisten?.().catch(() => {});
    },
  };
}
