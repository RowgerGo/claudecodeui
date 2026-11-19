import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import WorkspaceToolPanel from '@/modules/project-workspace/WorkspaceToolPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let reportWorkspaceWidth: (width: number) => void;
const onClose = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  onClose.mockClear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
      reportWorkspaceWidth = (width) => callback([{ contentRect: { width } }]);
    }
    observe() {}
    disconnect() {}
  });
});

afterEach(() => vi.unstubAllGlobals());

function workspace(isOpen = true) {
  return (
    <>
      <button type="button" aria-controls="workspace-tools">Tools</button>
      <WorkspaceToolPanel
        activeTab="files"
        isOpen={isOpen}
        onClose={onClose}
        navigation={<button type="button" role="tab" aria-selected="true" id="workspace-tool-tab-files">Files</button>}
        chat={(visible) => <textarea aria-label="Chat" data-visible={visible} />}
        tools={({ compact, visible }) => <input aria-label="File name" data-compact={compact} data-visible={visible} />}
      />
    </>
  );
}

function measure(width: number) {
  act(() => reportWorkspaceWidth(width));
}

test('collapsing, expanding and resizing the workspace retain both mounted views', () => {
  const view = render(workspace());
  measure(1100);
  const chat = screen.getByRole('textbox', { name: 'Chat' });
  const fileName = screen.getByRole('textbox', { name: 'File name' });
  expect(fileName.dataset.compact).toBe('true');
  fireEvent.change(chat, { target: { value: 'unfinished prompt' } });
  fireEvent.change(fileName, { target: { value: 'draft.ts' } });

  fireEvent.click(screen.getByRole('button', { name: 'toolPanel.expand' }));
  expect(chat.dataset.visible).toBe('false');
  expect(fileName.dataset.compact).toBe('false');
  expect(screen.queryByRole('separator')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'toolPanel.restore' }));
  expect(chat.dataset.visible).toBe('true');

  // Docking the quick settings drawer can remove room without a viewport resize.
  measure(730);
  expect(screen.queryByRole('separator')).toBeNull();
  expect(chat.dataset.visible).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'toolPanel.backToChat' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Tools' }));
  view.rerender(workspace(false));
  expect(screen.getByDisplayValue('unfinished prompt')).toBe(chat);
  expect(chat.dataset.visible).toBe('true');
  expect(fileName.dataset.visible).toBe('false');

  view.rerender(workspace());
  measure(1100);
  expect(screen.getByDisplayValue('draft.ts')).toBe(fileName);
  expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('440');
});

test('clamping a saved width preserves the preference until the user resizes', () => {
  const view = render(workspace());
  measure(1200);
  const divider = screen.getByRole('separator');
  fireEvent.keyDown(divider, { key: 'End' });
  expect(divider.getAttribute('aria-valuenow')).toBe('720');
  measure(850);
  expect(divider.getAttribute('aria-valuenow')).toBe('370');
  measure(1200);
  expect(divider.getAttribute('aria-valuenow')).toBe('720');
  fireEvent.keyDown(divider, { key: 'ArrowRight' });
  expect(divider.getAttribute('aria-valuenow')).toBe('696');

  view.unmount();
  render(workspace());
  measure(1200);
  expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('696');
});

test('only an exclusive panel takes focus, and text input and open menus keep their Escape', () => {
  const view = render(workspace(false));
  measure(1100);
  const chat = screen.getByRole('textbox', { name: 'Chat' });
  chat.focus();
  view.rerender(workspace());
  expect(document.activeElement).toBe(chat);

  measure(700);
  const tab = screen.getByRole('tab', { name: 'Files' });
  expect(document.activeElement).toBe(tab);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'File name' }), { key: 'Escape' });
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  document.body.append(menu);
  fireEvent.keyDown(tab, { key: 'Escape' });
  menu.remove();
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.keyDown(tab, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Tools' }));
});

test('dragging the divider moves the panel and persists its final width', () => {
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    readonly pointerId = 1;
  });
  const view = render(workspace());
  measure(1200);
  const divider = screen.getByRole('separator');
  divider.setPointerCapture = vi.fn();
  fireEvent.pointerDown(divider, { button: 0, clientX: 760 });
  fireEvent.pointerMove(divider, { clientX: 660 });
  expect(divider.getAttribute('aria-valuenow')).toBe('540');
  fireEvent.pointerUp(divider, { clientX: 690 });
  expect(divider.getAttribute('aria-valuenow')).toBe('510');

  view.unmount();
  render(workspace());
  measure(1200);
  expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('510');
});
