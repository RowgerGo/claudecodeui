import { ArrowLeft, Maximize2, Minimize2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ESCAPE_LAYER_SELECTOR } from '@/shared/constants';
import type { WorkspaceTool } from '@/shared/types';

type WorkspaceToolPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  activeTab: WorkspaceTool;
  navigation: ReactNode;
  chat: (visible: boolean) => ReactNode;
  tools: (layout: { compact: boolean; visible: boolean }) => ReactNode;
};

const WIDTH_KEY = 'workspace-tool-panel-width';
const DEFAULT_TOOL_WIDTH = 440;
const MIN_TOOL_WIDTH = 320;
const MIN_CHAT_WIDTH = 480;
const COMPACT_TOOL_WIDTH = 640;
const KEYBOARD_STEP = 24;

function readPreferredWidth() {
  try {
    const width = Number(window.localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(width) && width >= MIN_TOOL_WIDTH) return Math.round(width);
  } catch {
    // Storage can be disabled; the divider still works for this visit.
  }
  return DEFAULT_TOOL_WIDTH;
}

function storePreferredWidth(width: number) {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // Keep the current layout when preferences cannot be persisted.
  }
}

/** Used by WorkspaceMain to keep chat and project tools mounted across docked and full-width layouts. */
export default function WorkspaceToolPanel({ isOpen, onClose, activeTab, navigation, chat, tools }: WorkspaceToolPanelProps) {
  const { t } = useTranslation();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; originX: number; originWidth: number } | null>(null);
  // The sidebar and pinned settings both change the space available to this row.
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  // Retain the user's preferred width when other panels temporarily constrain it.
  const [preferredWidth, setPreferredWidth] = useState(readPreferredWidth);
  // Explicitly expanding a tool uses the whole row until restored or closed.
  const [expanded, setExpanded] = useState(false);
  if (!isOpen && expanded) setExpanded(false);
  const fitsSplit = workspaceWidth >= MIN_CHAT_WIDTH + MIN_TOOL_WIDTH;
  const exclusive = isOpen && (!fitsSplit || expanded);
  const maxToolWidth = Math.max(MIN_TOOL_WIDTH, workspaceWidth - MIN_CHAT_WIDTH);
  const dockedWidth = Math.min(preferredWidth, maxToolWidth);
  const currentWidth = exclusive ? workspaceWidth : dockedWidth;
  const compact = currentWidth < COMPACT_TOOL_WIDTH;
  // Reuse both trees while dragging; only a change in visibility or density affects their props.
  const chatContent = useMemo(() => chat(!exclusive), [chat, exclusive]);
  const toolContent = useMemo(() => tools({ compact, visible: isOpen }), [tools, compact, isOpen]);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    setWorkspaceWidth(workspace.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWorkspaceWidth(entry.contentRect.width));
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isOpen || exclusive) dragRef.current = null;
  }, [exclusive, isOpen]);

  const hasMeasuredWorkspace = workspaceWidth > 0;
  useLayoutEffect(() => {
    const panel = toolsRef.current;
    if (!exclusive || !hasMeasuredWorkspace || !panel) return;
    const focused = document.activeElement;
    if (focused && panel.contains(focused) && !focused.closest('[hidden]')) return;
    // A narrow workspace hides chat. Move focus out of the hidden conversation,
    // but leave unrelated settings, project navigation and modal dialogs alone.
    if (focused !== document.body && !workspaceRef.current?.contains(focused)
      && !focused?.matches('button[aria-controls="workspace-tools"]')) return;
    if (document.querySelector(ESCAPE_LAYER_SELECTOR)) return;
    const selectedTab = panel.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    selectedTab?.focus({ preventScroll: true });
  }, [activeTab, exclusive, hasMeasuredWorkspace]);

  function closePanel() {
    onClose();
    document.querySelector<HTMLButtonElement>('button[aria-controls="workspace-tools"]')?.focus();
  }

  function handlePanelEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.nativeEvent.isComposing) return;
    const target = event.target;
    // Portal events can bubble through the React tree even when their DOM is outside the panel.
    if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
    if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-workspace-editor], [data-browser-surface]')) return;
    if ((activeTab === 'shell' || activeTab === 'tasks' || activeTab.startsWith('plugin:')) && target.closest('#workspace-tool-content')) return;
    if (document.querySelector(ESCAPE_LAYER_SELECTOR)) return;
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  }

  function resize(width: number, persist: boolean) {
    const next = Math.round(Math.min(maxToolWidth, Math.max(MIN_TOOL_WIDTH, width)));
    setPreferredWidth(next);
    if (persist) storePreferredWidth(next);
  }

  function handleResizeStart(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, originX: event.clientX, originWidth: dockedWidth };
  }

  function handleResize(event: PointerEvent<HTMLDivElement>, finished: boolean) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resize(drag.originWidth + drag.originX - event.clientX, finished);
    if (finished) dragRef.current = null;
  }

  function handleResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': next = dockedWidth + KEYBOARD_STEP; break;
      case 'ArrowRight': next = dockedWidth - KEYBOARD_STEP; break;
      case 'Home': next = MIN_TOOL_WIDTH; break;
      case 'End': next = maxToolWidth; break;
      default: return;
    }
    event.preventDefault();
    resize(next, true);
  }

  const closeLabel = t(exclusive ? 'toolPanel.backToChat' : 'toolPanel.close');
  const expandLabel = t(expanded ? 'toolPanel.restore' : 'toolPanel.expand');
  const buttonClass = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div ref={workspaceRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div hidden={exclusive} className={exclusive ? 'hidden' : 'min-h-0 min-w-0 flex-1 overflow-hidden'}>
        {chatContent}
      </div>
      <aside
        ref={toolsRef}
        id="workspace-tools"
        data-workspace-tools=""
        data-exclusive={exclusive}
        onKeyDown={handlePanelEscape}
        hidden={!isOpen}
        aria-label={t('toolPanel.name')}
        className={isOpen ? 'relative flex min-h-0 min-w-0 shrink-0 flex-col bg-background' : 'hidden'}
        style={isOpen ? { width: exclusive ? '100%' : dockedWidth } : undefined}
      >
        {isOpen && !exclusive && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-controls="workspace-tools"
            aria-label={t('toolPanel.resize')}
            aria-valuemin={MIN_TOOL_WIDTH}
            aria-valuemax={maxToolWidth}
            aria-valuenow={dockedWidth}
            tabIndex={0}
            className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none select-none after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-border hover:after:bg-primary focus-visible:outline-none focus-visible:after:bg-primary"
            onPointerDown={handleResizeStart}
            onPointerMove={(event) => handleResize(event, false)}
            onPointerUp={(event) => handleResize(event, true)}
            onLostPointerCapture={() => { dragRef.current = null; }}
            onKeyDown={handleResizeKey}
          />
        )}
        <div className="flex min-w-0 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 py-1.5">
          {navigation}
          {fitsSplit && (
            <button type="button" aria-label={expandLabel} title={expandLabel} className={buttonClass} onClick={() => setExpanded(!expanded)}>
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          )}
          <button type="button" aria-label={closeLabel} title={closeLabel} className={buttonClass} onClick={closePanel}>
            {exclusive ? <ArrowLeft size={16} /> : <X size={16} />}
          </button>
        </div>
        <div
          role="tabpanel"
          id="workspace-tool-content"
          aria-labelledby={`workspace-tool-tab-${activeTab}`}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          {toolContent}
        </div>
      </aside>
    </div>
  );
}
