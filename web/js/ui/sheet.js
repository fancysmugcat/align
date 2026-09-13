import { h } from './components.js';

const root = () => document.getElementById('overlay-root');

/**
 * Modal sheet — the web stand-in for the app's presented sheets. Closes on
 * Escape or a backdrop click, and returns focus where it came from.
 */
export function openSheet({ title, closeLabel = 'Done', body, centered = false, onClose }) {
  const previousFocus = document.activeElement;

  const closeButton = h('button', {
    type: 'button', class: 'link-button', text: closeLabel, onClick: () => close(),
  });

  const sheet = h('div', {
    class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
  }, [
    h('div', { class: 'sheet-bar' }, [
      h('h2', { class: 'sheet-title', text: title }),
      closeButton,
    ]),
    h('div', { class: `sheet-body${centered ? ' sheet-body--centered' : ''}` }, [body]),
  ]);

  const overlay = h('div', {
    class: 'overlay',
    onClick: (event) => { if (event.target === overlay) close(); },
  }, [sheet]);

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  function close() {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
    document.body.style.overflow = '';
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
    onClose?.();
  }

  document.addEventListener('keydown', onKeydown);
  document.body.style.overflow = 'hidden';
  root().append(overlay);
  closeButton.focus();

  return { close, sheet };
}
