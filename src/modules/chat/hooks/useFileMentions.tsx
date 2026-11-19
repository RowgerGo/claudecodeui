import { useCallback, useMemo, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';

import { useProjectFileSearch } from '@/shared/hooks/useProjectFileSearch';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import type { MentionableFile, Project } from '@/shared/types';

type UseFileMentionsOptions = {
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
};

/** Supplies the chat composer with bounded, project-wide file suggestions for its active @ query. */
export function useFileMentions({ selectedProject, input, setInput, textareaRef }: UseFileMentionsOptions) {
  // Inserted paths stay highlighted while their text is still present.
  const [fileMentions, setFileMentions] = useState<string[]>([]);
  // The caret determines which mention in a multiline message is active.
  const [cursorPosition, setCursorPosition] = useState(0);
  const projectId = selectedProject?.projectId;
  const mention = useMemo(() => {
    const beforeCursor = input.slice(0, cursorPosition);
    const start = beforeCursor.lastIndexOf('@');
    const query = beforeCursor.slice(start + 1);
    return projectId && start >= 0 && !/\s/.test(query) ? { start, query, projectId } : null;
  }, [input, cursorPosition, projectId]);
  // Keyboard navigation and Escape apply only to the mention currently being edited.
  const [selection, setSelection] = useState<{ mention: typeof mention; index: number | 'dismissed' } | null>(null);
  const choice = selection && selection.mention === mention ? selection.index : -1;
  const selectedFileIndex = typeof choice === 'number' ? choice : -1;
  const showFileDropdown = !!mention && choice !== 'dismissed';
  const { entries } = useProjectFileSearch(projectId, showFileDropdown ? mention.query : null, {
    filesOnly: true, limit: 10,
  });
  const filteredFiles = useMemo(() => entries.map(({ name, relativePath }) => ({ name, path: relativePath })), [entries]);

  const activeFileMentions = useMemo(() => {
    if (!input || fileMentions.length === 0) {
      return [];
    }
    return fileMentions.filter((path) => input.includes(path));
  }, [fileMentions, input]);

  const sortedFileMentions = useMemo(() => {
    if (activeFileMentions.length === 0) {
      return [];
    }
    const uniqueMentions = Array.from(new Set(activeFileMentions));
    return uniqueMentions.sort((mentionA, mentionB) => mentionB.length - mentionA.length);
  }, [activeFileMentions]);

  const fileMentionRegex = useMemo(() => {
    if (sortedFileMentions.length === 0) {
      return null;
    }
    const pattern = sortedFileMentions.map(escapeRegExp).join('|');
    return new RegExp(`(${pattern})`, 'g');
  }, [sortedFileMentions]);

  const fileMentionSet = useMemo(() => new Set(sortedFileMentions), [sortedFileMentions]);

  const renderInputWithMentions = useCallback(
    (text: string) => {
      if (!text) {
        return '';
      }
      if (!fileMentionRegex) {
        return text;
      }

      const parts = text.split(fileMentionRegex);
      return parts.map((part, index) =>
        fileMentionSet.has(part) ? (
          <span
            key={`mention-${index}`}
            className="-ml-0.5 rounded-md bg-blue-200/70 box-decoration-clone px-0.5 text-transparent dark:bg-blue-300/40"
          >
            {part}
          </span>
        ) : (
          <span key={`text-${index}`}>{part}</span>
        ),
      );
    },
    [fileMentionRegex, fileMentionSet],
  );

  const selectFile = useCallback(
    (file: MentionableFile) => {
      if (!mention) return;
      const atSymbolPosition = mention.start;
      const textBeforeAt = input.slice(0, atSymbolPosition);
      const textAfterAtQuery = input.slice(atSymbolPosition);
      const spaceIndex = textAfterAtQuery.indexOf(' ');
      const textAfterQuery = spaceIndex !== -1 ? textAfterAtQuery.slice(spaceIndex) : '';

      const newInput = `${textBeforeAt}${file.path} ${textAfterQuery}`;
      const newCursorPosition = textBeforeAt.length + file.path.length + 1;

      if (textareaRef.current && !textareaRef.current.matches(':focus')) {
        textareaRef.current.focus();
      }

      setInput(newInput);
      setCursorPosition(newCursorPosition);
      setFileMentions((previousMentions) =>
        previousMentions.includes(file.path) ? previousMentions : [...previousMentions, file.path],
      );

      setSelection({ mention, index: 'dismissed' });

      if (!textareaRef.current) {
        return;
      }

      requestAnimationFrame(() => {
        if (!textareaRef.current) {
          return;
        }
        textareaRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        if (!textareaRef.current.matches(':focus')) {
          textareaRef.current.focus();
        }
      });
    },
    [input, mention, textareaRef, setInput],
  );

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileDropdown) {
        return false;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setSelection({ mention, index: 'dismissed' });
        return true;
      }

      if (filteredFiles.length === 0) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelection({ mention, index: selectedFileIndex < filteredFiles.length - 1 ? selectedFileIndex + 1 : 0 });
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelection({ mention, index: selectedFileIndex > 0 ? selectedFileIndex - 1 : filteredFiles.length - 1 });
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        if (filteredFiles[selectedFileIndex]) {
          selectFile(filteredFiles[selectedFileIndex]);
        } else if (filteredFiles.length > 0) {
          selectFile(filteredFiles[0]);
        }
        return true;
      }

      return false;
    },
    [showFileDropdown, filteredFiles, selectedFileIndex, selectFile, mention],
  );

  return {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  };
}
