import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AppTab, Project } from '@/shared/types';
import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';

const { palette, subscribe } = vi.hoisted(() => ({
  palette: { openFileInEditor: (_path: string, _line?: number) => {}, openDirectory: (_path: string) => {} },
  subscribe: () => () => {},
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/command-palette', () => ({
  usePaletteOpsRegister: (handlers: typeof palette) => Object.assign(palette, handlers),
}));
vi.mock('@/shared/context/UiPreferencesContext', () => ({ useUiPreferences: () => ({}) }));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [], loading: false }) }));
vi.mock('@/modules/browser-use', () => ({ useBrowserUseEnabled: () => false }));
vi.mock('@/modules/task-master', () => ({
  useTaskMasterProjectSync: () => {},
  useTasksSettings: () => ({ tasksEnabled: false }),
}));
vi.mock('@/modules/chat', () => ({
  ChatInterface: ({ isActive }: { isActive: boolean }) => (
    <>
      <textarea aria-label="Chat draft" data-active={isActive} />
      <button type="button" onClick={() => palette.openFileInEditor('/repo/source.ts', 17)}>source.ts:17</button>
      <button type="button" onClick={() => palette.openDirectory('src')}>src/</button>
    </>
  ),
}));
vi.mock('@/modules/file-tree', () => ({
  FileTree: ({ revealDirectory }: { revealDirectory?: { path: string } }) => (
    <span>Directory {revealDirectory?.path}</span>
  ),
}));
vi.mock('@/modules/standalone-shell', () => ({ StandaloneShell: () => <input aria-label="Shell" /> }));
vi.mock('@/modules/git-panel', () => ({ GitPanel: () => <span>Git changes</span> }));
vi.mock(import('@/modules/code-editor'), async importOriginal => {
  const original = await importOriginal();
  return {
    ...original,
    EditorSidebar: props => (
      props.embedded && props.editingFile
        ? <input hidden={!props.visible} aria-label="Edit file" data-line={props.editingFile.line} />
        : null
    ),
  };
});
vi.mock('@/modules/project-workspace/WorkspaceHeader', () => ({
  default: ({ onToggleTools }: { onToggleTools: () => void }) => (
    <button type="button" aria-controls="workspace-tools" onClick={onToggleTools}>Tools</button>
  ),
}));

const project: Project = { projectId: 'p', displayName: 'Project', fullPath: '/repo' };
const noop = () => {};
function Workspace() {
  const [tab, setTab] = useState<AppTab>('chat');
  return (
    <WorkspaceMain
      selectedProject={project} selectedSession={{ id: 's' }}
      activeTab={tab} lastTool="files" setActiveTab={setTab}
      ws={null} sendMessage={noop} isMobile={false} onMenuClick={noop} isLoading={false}
      onNavigateToSession={noop} onSessionEstablished={noop} onShowSettings={noop}
      externalMessageUpdate={0} newSessionTrigger={0} onProjectSelect={noop} onProjectsRefresh={noop}
      onRenameSession={async () => true}
    />
  );
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

afterEach(() => vi.unstubAllGlobals());

it('opens a chat file reference at its line and preserves the chat, editor and shell while switching tools', () => {
  render(<Workspace />);
  const chat = screen.getByRole('textbox', { name: 'Chat draft' });
  fireEvent.change(chat, { target: { value: 'continue here' } });
  expect(screen.queryByLabelText('Shell')).toBeNull();

  fireEvent.click(screen.getByText('source.ts:17'));
  const editor = screen.getByRole('textbox', { name: 'Edit file' });
  expect(editor.dataset.line).toBe('17');
  expect(chat.dataset.active).toBe('true');
  fireEvent.change(editor, { target: { value: 'in progress' } });

  fireEvent.click(screen.getByRole('tab', { name: 'tabs.shell' }));
  const shell = screen.getByRole('textbox', { name: 'Shell' });
  fireEvent.click(screen.getByRole('tab', { name: 'tabs.files' }));
  expect(screen.getByDisplayValue('in progress')).toBe(editor);
  fireEvent.click(screen.getByRole('button', { name: 'toolPanel.close' }));
  expect(screen.queryByRole('textbox', { name: 'Edit file' })).toBeNull();
  expect(screen.getByDisplayValue('continue here')).toBe(chat);

  fireEvent.click(screen.getByText('src/'));
  expect(screen.getByText('Directory src')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Edit file' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'tabs.shell' }));
  expect(screen.getByRole('textbox', { name: 'Shell' })).toBe(shell);
});
