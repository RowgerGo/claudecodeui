import { useEffect } from 'react';
import type { RefObject } from 'react';

import { ESCAPE_LAYER_SELECTOR } from '@/shared/constants';

type UseEditorKeyboardShortcutsParams = {
  onSave: () => void;
  onClose: () => void;
  shortcutScope?: RefObject<HTMLElement>;
};

export const useEditorKeyboardShortcuts = ({
  onSave,
  onClose,
  shortcutScope,
}: UseEditorKeyboardShortcutsParams) => {
  useEffect(() => {
    // A docked workspace editor shares the page with the chat and terminal.
    // Only keyboard events from its visible pane belong to its document.
    const pane = shortcutScope?.current;
    const target = shortcutScope ? pane : document;
    if (!target) return;
    const handleKeyDown = (event: Event) => {
      if (!(event instanceof KeyboardEvent) || pane?.hidden || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        // Leave Escapes another handler consumed or a layer above the editor
        // owns: open menus and modal dialogs close on Escape themselves.
        if (document.querySelector(ESCAPE_LAYER_SELECTOR)) {
          return;
        }

        event.preventDefault();
        onClose();
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        onSave();
      }
    };

    target.addEventListener('keydown', handleKeyDown);
    return () => {
      target.removeEventListener('keydown', handleKeyDown);
    };
  }, [shortcutScope, onClose, onSave]);
};
