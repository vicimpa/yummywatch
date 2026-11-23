const editable =
  'textarea,input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=reset]):not([type=color]):not([type=hidden]),[contenteditable]:not([contenteditable=false])';

// Native word selection stays within content; explicit Select All can span a panel.
export const SELECTABLE_CONTENT = [
  '.card-title',
  '.card-caption p',
  '.gallery-feature-copy h2',
  '.gallery-feature-description',
  '.gallery-continue h3',
  '.result-copy',
  '.history-copy',
  '.schedule-card h3',
  '.subscription-card h3',
  '.poster-fallback span',
  '.watch-title h1',
  '.detail-meta',
  '.full-synopsis',
  '.anime-facts dd',
  '.viewing-order strong',
  '.sidebar-header p',
  '.comment-text',
  '.comment-author',
  '.comment-author-name',
  '.card-title-tooltip',
  '[data-selectable]',
  editable,
].join(',');

const copyable = SELECTABLE_CONTENT;

/** Select content in context, keeping application chrome out of native selection. */
export function installSelectionPolicy() {
  let allRange: Range | undefined;
  const element = (node: EventTarget | Node | null) =>
    node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  const keydown = (event: KeyboardEvent) => {
    if (
      !(event.ctrlKey || event.metaKey) ||
      (event.code !== 'KeyA' && event.key.toLowerCase() !== 'a')
    )
      return;

    const field = element(event.target)?.closest(editable);

    if (field) {
      allRange = undefined;
      if (field instanceof HTMLInputElement && field.selectionStart === null) return;
      if (
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLElement
      ) {
        event.preventDefault();
        const selection = window.getSelection();

        selection?.removeAllRanges();
        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
          field.focus({ preventScroll: true });
          field.select();
        } else {
          const range = document.createRange();

          range.selectNodeContents(field);
          selection?.addRange(range);
        }
      }

      return;
    }

    event.preventDefault();
    const selection = window.getSelection();
    const target =
      element(selection?.anchorNode || null)?.closest(copyable) ||
      element(event.target)?.closest(copyable);
    const scope =
      target ||
      document.querySelector('[data-sidebar-open=true] .sidebar-scroll') ||
      document.querySelector('#main');
    selection?.removeAllRanges();
    if (scope && (target || scope.querySelector(copyable))) {
      const range = document.createRange();
      range.selectNodeContents(scope);
      allRange = range.cloneRange();
      selection?.addRange(range);
    }
  };
  const selectstart = (event: Event) => {
    const target = element(event.target);
    if (!target || target.closest(editable)) return;
    allRange = undefined;
    if (!target.closest(copyable)) event.preventDefault();
  };
  const selectionchange = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const ancestor = element(selection.getRangeAt(0).commonAncestorContainer);
    const range = selection.getRangeAt(0);
    if (
      allRange &&
      range.compareBoundaryPoints(Range.START_TO_START, allRange) === 0 &&
      range.compareBoundaryPoints(Range.END_TO_END, allRange) === 0
    )
      return;
    if (!ancestor?.closest(copyable)) selection.removeAllRanges();
  };
  const dragstart = (event: DragEvent) => {
    const target = element(event.target);
    if (!target || target.closest(editable)) return;
    const selection = window.getSelection();
    if (target.closest(copyable) && selection && !selection.isCollapsed) return;
    if (!target.closest('a[href]:not([draggable="false"])')) event.preventDefault();
  };
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('selectstart', selectstart);
  document.addEventListener('selectionchange', selectionchange);
  document.addEventListener('dragstart', dragstart, true);
  return () => {
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('selectstart', selectstart);
    document.removeEventListener('selectionchange', selectionchange);
    document.removeEventListener('dragstart', dragstart, true);
  };
}
